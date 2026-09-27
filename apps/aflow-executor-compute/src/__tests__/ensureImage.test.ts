import { describe, it, expect } from 'vitest';
import { googleRegistryHost, isRepositoryBuiltImage } from '../ensureImage.js';

describe('googleRegistryHost', () => {
  it('detects Artifact Registry hosts (needs authenticated pull)', () => {
    expect(
      googleRegistryHost('europe-west3-docker.pkg.dev/aflowai/phoenix/phoenix-python-ml:latest'),
    ).toBe('europe-west3-docker.pkg.dev');
  });

  it('detects gcr.io hosts', () => {
    expect(googleRegistryHost('gcr.io/project/image:tag')).toBe('gcr.io');
    expect(googleRegistryHost('eu.gcr.io/project/image')).toBe('eu.gcr.io');
  });

  it('treats Docker Hub library images as public (no host segment)', () => {
    expect(googleRegistryHost('python:3.12-slim')).toBeNull();
    expect(googleRegistryHost('node:22-slim')).toBeNull();
    expect(googleRegistryHost('alpine:3.20')).toBeNull();
    expect(googleRegistryHost('phoenix-python-ml:latest')).toBeNull();
  });

  it('treats Docker Hub namespaced images as public', () => {
    expect(googleRegistryHost('denoland/deno:alpine')).toBeNull();
  });

  it('does not authenticate non-Google registries', () => {
    expect(googleRegistryHost('ghcr.io/org/image:tag')).toBeNull();
    expect(googleRegistryHost('registry.example.com/image')).toBeNull();
  });
});

describe('an image this repository builds', () => {
  /**
   * The ML runtime is built here, not served by a registry. Its bare name is a
   * Docker Hub library reference, so pulling it reports that the repository does
   * not exist or needs a login — an answer about Hub, and nothing to do with why
   * the image is missing. Recognising it lets the failure say what is actually
   * wrong and what to run.
   */
  it('recognises the ML runtime as built here', () => {
    expect(isRepositoryBuiltImage('phoenix-python-ml:latest')).toBe(true);
  });

  it('leaves stock images to the registry that serves them', () => {
    for (const image of [
      'python:3.12-slim',
      'node:22-slim',
      'alpine:3.20',
      'denoland/deno:alpine',
    ]) {
      expect(isRepositoryBuiltImage(image), image).toBe(false);
    }
  });

  it('defers to a registry once one is named, which is how production takes it', () => {
    expect(
      isRepositoryBuiltImage(
        'europe-west3-docker.pkg.dev/aflowai/phoenix/phoenix-python-ml:latest',
      ),
    ).toBe(false);
  });
});
