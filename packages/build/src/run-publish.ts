import type { writeBuildInfo as writeBuildInfoType } from './build-info';
import { Barque } from './barque';
import {
  ALL_BUILD_VARIANTS,
  Config,
  getReleaseVersionFromTag,
  shouldDoPublicRelease as shouldDoPublicReleaseFn
} from './config';
import { createAndPublishDownloadCenterConfig as createAndPublishDownloadCenterConfigFn } from './download-center';
import { getArtifactUrl as getArtifactUrlFn } from './evergreen';
import { GithubRepo } from './github-repo';
import type { publishToHomebrew as publishToHomebrewType } from './homebrew';
import type { publishNpmPackages as publishNpmPackagesType } from './npm-packages';
import { PackageInformation, getPackageFile } from './packaging';

export async function runPublish(
  config: Config,
  mongoshGithubRepo: GithubRepo,
  mongodbHomebrewForkGithubRepo: GithubRepo,
  homebrewCoreGithubRepo: GithubRepo,
  barque: Barque,
  createAndPublishDownloadCenterConfig: typeof createAndPublishDownloadCenterConfigFn,
  publishNpmPackages: typeof publishNpmPackagesType,
  writeBuildInfo: typeof writeBuildInfoType,
  publishToHomebrew: typeof publishToHomebrewType,
  shouldDoPublicRelease: typeof shouldDoPublicReleaseFn = shouldDoPublicReleaseFn,
  getEvergreenArtifactUrl: typeof getArtifactUrlFn = getArtifactUrlFn
): Promise<void> {
  if (!shouldDoPublicRelease(config)) {
    console.warn('mongosh: Not triggering publish - configuration does not match a public release!');
    return;
  }

  const releaseVersion = getReleaseVersionFromTag(config.triggeringGitTag);
  const latestDraftTag = await mongoshGithubRepo.getMostRecentDraftTagForRelease(releaseVersion);
  if (!latestDraftTag || !releaseVersion) {
    throw new Error(`Could not find prior draft tag for release version: ${releaseVersion}`);
  }
  if (latestDraftTag.sha !== config.revision) {
    throw new Error(`Version mismatch - latest draft tag was for revision ${latestDraftTag.sha}, current revision is ${config.revision}`);
  }

  const packageName = config.packageInformation?.metadata.name;
  if (!packageName) {
    throw new Error('Missing package name from config.packageInformation.metadata');
  }

  console.info('mongosh: Re-using artifacts from most recent draft tag', latestDraftTag.name);

  await publishArtifactsToBarque(
    barque,
    config.project as string,
    releaseVersion,
    latestDraftTag.name,
    config.packageInformation as PackageInformation,
    getEvergreenArtifactUrl
  );

  await createAndPublishDownloadCenterConfig(
    config.packageInformation as PackageInformation,
    config.downloadCenterAwsKey || '',
    config.downloadCenterAwsSecret || ''
  );

  await mongoshGithubRepo.promoteRelease(config);

  // ensures the segment api key to be present in the published packages
  await writeBuildInfo(config, 'packaged');

  publishNpmPackages();

  await publishToHomebrew(
    homebrewCoreGithubRepo,
    mongodbHomebrewForkGithubRepo,
    config.version,
    `https://github.com/${mongoshGithubRepo.repo.owner}/${mongoshGithubRepo.repo.repo}/releases/tag/v${config.version}`
  );

  console.info('mongosh: finished release process.');
}

async function publishArtifactsToBarque(
  barque: Barque,
  project: string,
  releaseVersion: string,
  mostRecentDraftTag: string,
  packageInformation: PackageInformation,
  getEvergreenArtifactUrl: typeof getArtifactUrlFn
): Promise<void> {
  const publishedPackages: string[] = [];
  for await (const variant of ALL_BUILD_VARIANTS) {
    const packageFile = getPackageFile(variant, {
      ...packageInformation,
      metadata: {
        ...packageInformation.metadata,
        version: releaseVersion
      }
    });
    const packageUrl = getEvergreenArtifactUrl(project, mostRecentDraftTag, packageFile.path);
    console.info(`mongosh: Considering publishing ${variant} artifact to barque ${packageUrl}`);
    const packageUrls = await barque.releaseToBarque(variant, packageUrl);
    for (const url of packageUrls) {
      console.info(` -> ${url}`);
    }
    publishedPackages.push(...packageUrls);
  }

  await barque.waitUntilPackagesAreAvailable(publishedPackages, 300);

  console.info('mongosh: Submitting to barque complete');
}
