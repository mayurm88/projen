import { Task } from '..';
import { Component } from '../component';
import { GitHub, GitHubProject, GithubWorkflow, GitIdentity } from '../github';
import { BUILD_ARTIFACT_NAME, DEFAULT_GITHUB_ACTIONS_USER } from '../github/constants';
import { WorkflowActions } from '../github/workflow-actions';
import { Job, JobPermission, JobStep } from '../github/workflows-model';
import { Project } from '../project';

const PULL_REQUEST_REF = '${{ github.event.pull_request.head.ref }}';
const PULL_REQUEST_REPOSITORY = '${{ github.event.pull_request.head.repo.full_name }}';
const BUILD_JOBID = 'build';
const DIFF_STEP = 'diff';
const DIFF_EXISTS = 'diff_exists';
const IS_FORK = 'github.event.pull_request.head.repo.full_name != github.repository';
const NOT_FORK = `!(${IS_FORK})`;

export interface BuildWorkflowOptions {
  /**
   * The task to execute in order to build the project.
   */
  readonly buildTask: Task;

  /**
   * A name of a directory that includes build artifacts.
   */
  readonly artifactsDirectory: string;

  /**
   * The container image to use for builds.
   * @default - the default workflow container
   */
  readonly containerImage?: string;

  /**
   * Automatically update files modified during builds to pull-request branches.
   * This means that any files synthesized by projen or e.g. test snapshots will
   * always be up-to-date before a PR is merged.
   *
   * Implies that PR builds do not have anti-tamper checks.
   *
   * This is enabled by default only if `githubTokenSecret` is set. Otherwise it
   * is disabled, which implies that file changes that happen during build will
   * not be pushed back to the branch.
   *
   * @default true
   */
  readonly mutableBuild?: boolean;

  /**
   * Steps to execute before the build.
   * @default []
   */
  readonly preBuildSteps?: JobStep[];

  /**
   * Steps to execute after build.
   * @default []
   */
  readonly postBuildSteps?: JobStep[];

  /**
   * Git identity to use for the workflow.
   * @default - default identity
   */
  readonly gitIdentity?: GitIdentity;

  /**
   * Build environment variables.
   * @default {}
   */
  readonly env?: { [key: string]: string };
}

export class BuildWorkflow extends Component {
  private readonly postBuildSteps: JobStep[];
  private readonly preBuildSteps: JobStep[];
  private readonly gitIdentity: GitIdentity;
  private readonly buildTask: Task;
  private readonly github: GitHub;
  private readonly workflow: GithubWorkflow;
  private readonly artifactsDirectory?: string;
  private readonly mutableBuilds: boolean;

  private readonly _postBuildJobs: string[] = [];

  constructor(project: Project, options: BuildWorkflowOptions) {
    super(project);

    const github = GitHub.of(project);
    if (!github) {
      throw new Error('BuildWorkflow is currently only supported for GitHub projects');
    }

    this.github = github;
    this.preBuildSteps = options.preBuildSteps ?? [];
    this.postBuildSteps = options.postBuildSteps ?? [];
    this.gitIdentity = options.gitIdentity ?? DEFAULT_GITHUB_ACTIONS_USER;
    this.buildTask = options.buildTask;
    this.artifactsDirectory = options.artifactsDirectory;
    this.mutableBuilds = options.mutableBuild ?? true;

    const conditions = [
      // if a diff doesn't exist, no need to update anything.
      `needs.${BUILD_JOBID}.outputs.${DIFF_EXISTS}`,

      // if its a fork, we cant push to it.
      NOT_FORK,
    ];

    const autoApproveLabel = (this.project as GitHubProject).autoApprove?.label;

    if (autoApproveLabel) {
      // if the pr is auto approved we don't perform self-mutation
      // because it may result in unexpected changes not being reviewed.
      conditions.push(`!contains(github.event.pull_request.labels.*.name, '${autoApproveLabel}')`);
    }


    this.workflow = new GithubWorkflow(github, 'build');
    this.workflow.on({
      pullRequest: {},
      workflowDispatch: {}, // allow manual triggering
    });

    this.addBuildJob(options);
    this.addAntiTamperJob();
    if (this.mutableBuilds) {
      this.addSelfMutationJob();
    }
  }

  private addBuildJob(options: BuildWorkflowOptions) {
    this.workflow.addJob(BUILD_JOBID, {
      runsOn: ['ubuntu-latest'],
      container: options.containerImage ? { image: options.containerImage } : undefined,
      env: {
        CI: 'true',
        ...options.env,
      },
      permissions: {
        contents: JobPermission.WRITE,
      },
      steps: (() => this.renderBuildSteps()) as any,
      outputs: {
        [DIFF_EXISTS]: {
          stepId: DIFF_STEP,
          outputName: DIFF_EXISTS,
        },
      },
    });
  }

  /**
   * Returns a list of job IDs that are part of the build.
   */
  public get buildJobIds(): string[] {
    return [BUILD_JOBID, ...this._postBuildJobs];
  }

  /**
   * Adds steps that are executed after the build.
   * @param steps The job steps
   */
  public addPostBuildSteps(...steps: JobStep[]): void {
    this.postBuildSteps.push(...steps);
  }

  /**
   * Adds another job to the build workflow which is executed after the build
   * job succeeded.
   *
   * Jobs are executed _only_ if the build did NOT self mutate. If the build
   * self-mutate, the branch will either be updated or the build will fail (in
   * forks), so there is no point in executing the post-build job.
   *
   * @param id The id of the new job
   * @param job The job specification
   */
  public addPostBuildJob(id: string, job: Job) {
    const steps = [];

    if (this.artifactsDirectory) {
      steps.push({
        name: 'Download build artifacts',
        uses: 'actions/download-artifact@v2',
        with: {
          name: BUILD_ARTIFACT_NAME,
          path: this.artifactsDirectory,
        },
      });
    }

    steps.push(...job.steps);

    this.workflow.addJob(id, {
      needs: [BUILD_JOBID],
      // only run if build did not self-mutate
      if: `\${{ ! needs.${BUILD_JOBID}.outputs.${DIFF_EXISTS} }}`,
      ...job,
      steps: steps,
    });

    // add to the list of build job IDs
    this._postBuildJobs.push(id);
  }


  private addSelfMutationJob() {
    this.workflow.addJob('self-mutation', {
      runsOn: ['ubuntu-latest'],
      permissions: {
        contents: JobPermission.WRITE,
      },
      needs: [BUILD_JOBID],
      if: `\${{ ${conditions.join('&&')} }}`,
      steps: [
        ...WorkflowActions.checkoutWithPatch({
          // we need to use a PAT so that our push will trigger the build workflow
          token: `\${{ secrets.${this.workflow.projenTokenSecret} }}`,
          ref: PULL_REQUEST_REF,
          repository: PULL_REQUEST_REPOSITORY,
        }),
        ...WorkflowActions.setGitIdentity(this.gitIdentity),
        {
          name: 'Push changes',
          run: [
            '  git add .',
            '  git commit -m "chore: self mutation"',
            `  git push origin HEAD:${PULL_REQUEST_REF}`,
          ].join('\n'),
        },
      ],
    });
  }

  /**
   * Adds a job that fails if there were file changes.
   */
  private addAntiTamperJob() {

    const conditions = [
      // if a diff doesn't exist, no tampering has been made.
      `needs.${BUILD_JOBID}.outputs.${DIFF_EXISTS}`,
    ];

    if (options.onlyForks) {
      //
    }
    const antitamperCondition = options.onlyForks
      ? `\${{ needs.${BUILD_JOBID}.outputs.${DIFF_EXISTS} && ${IS_FORK} }}`
      : `\${{ needs.${BUILD_JOBID}.outputs.${DIFF_EXISTS} }}`;

    this.workflow.addJob('anti-tamper', {
      runsOn: ['ubuntu-latest'],
      if: antitamperCondition,
      permissions: {},
      needs: [BUILD_JOBID],
      steps: [
        ...WorkflowActions.checkoutWithPatch({
          repository: PULL_REQUEST_REPOSITORY,
          ref: PULL_REQUEST_REF,
        }),
        {
          name: 'Found diff after build (update your branch)',
          run: 'git diff --staged --exit-code',
        },
      ],
    });
  }

  /**
   * Called (lazily) during synth to render the build job steps.
   */
  private renderBuildSteps(): JobStep[] {
    return [
      {
        name: 'Checkout',
        uses: 'actions/checkout@v2',
        with: {
          ref: PULL_REQUEST_REF,
          repository: PULL_REQUEST_REPOSITORY,
        },
      },

      ...this.preBuildSteps,

      {
        name: this.buildTask.name,
        run: this.github.project.runTaskCommand(this.buildTask),
      },

      ...this.postBuildSteps,

      {
        name: 'diff',
        id: DIFF_STEP,
        run: `git diff --staged --exit-code || echo "::set-output name=${DIFF_EXISTS}::true"`,
      },

      ...WorkflowActions.createUploadGitPatch({
        if: `\${{ steps.${DIFF_STEP}.outputs.${DIFF_EXISTS} }}`,
      }),

      // upload the build artifact only if we have post-build jobs and only if
      // there we NO self mutation.
      ...(this._postBuildJobs.length == 0 ? [] : [{
        name: 'Upload artifact',
        uses: 'actions/upload-artifact@v2.1.1',
        if: `\${{ ! steps.${DIFF_STEP}.outputs.${DIFF_EXISTS} }}`,
        with: {
          name: BUILD_ARTIFACT_NAME,
          path: this.artifactsDirectory,
        },
      }]),
    ];
  }
}
