import * as core from '@actions/core';
import { exec, ExecOptions, getExecOutput } from '@actions/exec';
import * as glob from '@actions/glob';
import * as fs from 'fs';
import * as yaml from 'js-yaml';

import { Metadata } from '../../types';

/* eslint-disable camelcase */

class Charmcraft {
  private uploadImage: boolean;
  private token: string;
  private execOptions: ExecOptions;

  constructor(token?: string) {
    this.uploadImage = core.getInput('upload-image').toLowerCase() === 'true';
    this.token = token || core.getInput('credentials');
    this.execOptions = {
      env: {
        ...process.env,
        CHARMCRAFT_AUTH: this.token,
      },
    };
  }

  async uploadResources(overrides?: { [key: string]: string }) {
    let resourceInfo = 'resources:\n';
    if (!this.uploadImage) {
      const msg =
        `No resources where uploaded as part of this build.\n` +
        `If you wish to upload the OCI image, set 'upload-image' to 'true'`;
      core.warning(msg);
    }

    const { name: charmName, images } = this.metadata();
    const flags: string[] = [];

    await Promise.all(
      images
        // If an image resource has been overridden in the action input,
        // we don't want to upload a new version of it either.
        .filter(
          ([name]) => !overrides || !Object.keys(overrides).includes(name)
        )
        .map(async ([name, image]) => {
          if (this.uploadImage) {
            await this.uploadResource(image, charmName, name);
          }
          const resourceFlag = await this.buildResourceFlag(
            charmName,
            name,
            image
          );

          if (!resourceFlag) return;

          flags.push(resourceFlag.flag);
          resourceInfo += resourceFlag.info;
        })
    );
    return { flags, resourceInfo };
  }

  async fetchFileFlags(overrides: { [key: string]: string }) {
    const { name: charmName, files } = this.metadata();
    // If an image resource has been overridden in the action input,
    // we don't want to upload a new version of it either.
    const filtered = files.filter(
      ([name]) => !overrides || !Object.keys(overrides).includes(name)
    );
    const result = { flags: [] as string[], resourceInfo: '' };
    await Promise.all(
      filtered.map(async (item) => {
        const flag = await this.buildResourceFlag(charmName, item, '');
        result.flags.push(flag.flag);
        result.resourceInfo += flag.info;
      })
    );

    return result;
  }

  buildStaticFlags(overrides: { [key: string]: string }) {
    if (!overrides) {
      return { flags: [] };
    }

    const flags = Object.entries(overrides!).map(
      ([key, value]) => `--resource=${key}:${value}`
    );

    const resourceInfo = [
      'Static resources:\n',
      ...Object.entries(overrides).map(
        ([key, val]) => `  - ${key}\n    resource-revision: ${val}\n`
      ),
    ].join('\n');

    return { flags, resourceInfo };
  }

  async uploadResource(
    resource_image: string,
    name: string,
    resource_name: string
  ) {
    const pullExitCode = await exec(
      'docker',
      ['pull', resource_image],
      this.execOptions
    );
    if (pullExitCode !== 0) {
      throw new Error('Could not pull the docker image.');
    }

    const args = [
      'upload-resource',
      '--quiet',
      name,
      resource_name,
      '--image',
      resource_image,
    ];
    await exec('charmcraft', args, this.execOptions);
  }

  async buildResourceFlag(charmName: string, name: string, image: string) {
    const args = ['resource-revisions', charmName, name];
    const result = await getExecOutput('charmcraft', args, this.execOptions);

    /*
    ❯ charmcraft resource-revisions prometheus-k8s prometheus-image
      Revision    Created at    Size
      2 <- This   2022-01-20    1024B
      1           2021-07-19    512B
      
    */

    if (result.stdout.trim().split('\n').length <= 1) {
      throw new Error(
        `Resource '${name}' does not have any uploaded revisions.`
      );
    }

    // Always pick the topmost resource revision, but skip the headers
    const revision = result.stdout.split('\n')[1].split(' ')[0];

    return {
      flag: `--resource=${name}:${revision}`,
      info:
        `    -  ${name}: ${image}\n` +
        `       resource-revision: ${revision}\n`,
    };
  }

  metadata() {
    const buffer = fs.readFileSync('metadata.yaml');
    const metadata = yaml.load(buffer.toString()) as Metadata;
    const resources = Object.entries(metadata.resources || {});

    const files = resources
      .filter(([, res]) => res.type === 'file')
      .map(([name]) => name);

    const images = resources
      .filter(([, res]) => res.type === 'oci-image')
      .map(([name, res]) => [name, res['upstream-source']]);

    return {
      images,
      files,
      name: metadata.name,
    };
  }

  async pack() {
    const args = ['pack', '--destructive-mode', '--quiet'];
    await exec('charmcraft', args, this.execOptions);
  }

  async upload(channel: string, flags: string[]): Promise<string> {
    // as we don't know the name of the name of the charm file output, we'll need to glob for it.
    // however, we expect charmcraft pack to always output one charm file.
    const globber = await glob.create('./*.charm');
    const paths = await globber.glob();

    const args = [
      'upload',
      '--quiet',
      '--release',
      channel,
      paths[0],
      ...flags,
    ];
    const result = await getExecOutput('charmcraft', args, this.execOptions);
    const newRevision = result.stdout.split(' ')[1];
    return newRevision;
  }

  async hasDriftingLibs(): Promise<LibStatus> {
    const { name } = this.metadata();
    const args = ['fetch-lib'];
    const result = await getExecOutput('charmcraft', args, this.execOptions);
    const re = new RegExp(`${name}`);
    const lines = result.stderr
      .concat(result.stdout)
      .split('\n')
      .filter((x) => !re.test(x))
      .filter((x) =>
        /(updated to version|not found in Charmhub|has local changes)/.test(x)
      );

    const { stdout: out, stderr: err } = result;

    return { ok: lines.length <= 0, out, err };
  }
}

export interface LibStatus {
  ok: boolean;
  out: string;
  err: string;
}

export { Charmcraft };