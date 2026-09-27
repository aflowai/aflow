import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProviderConfig } from '../types.js';
import { AIClientError } from '../errors.js';

const safeFetch = vi.fn();

vi.mock('@aflow/network-safety', async () => {
  const actual =
    await vi.importActual<typeof import('@aflow/network-safety')>('@aflow/network-safety');
  return {
    ...actual,
    safeFetch: (...args: unknown[]) => safeFetch(...args),
    validateUrl: async (rawUrl: string) => {
      const url = new URL(rawUrl);
      return { url, resolvedHost: { hostname: url.hostname, ip: '203.0.113.7', family: 4 } };
    },
  };
});

const { createRunwareAdapter, runwareTaskUuid } = await import('./runware.js');

const CONFIG: ProviderConfig = { apiKey: 'test-key' };
const MODEL = 'klingai:kling-video@3-standard';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', (...args: unknown[]) => fetchMock(...args));

function respondWith(body: unknown, status = 200): void {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  });
}

/** The task object the adapter sent on its most recent submit. */
function sentTask(): Record<string, unknown> {
  const init = fetchMock.mock.calls.at(-1)?.[1] as { body: string };
  return (JSON.parse(init.body) as Array<Record<string, unknown>>)[0]!;
}

function submitRequest(overrides: Record<string, unknown> = {}) {
  return {
    model: MODEL,
    prompt: 'a neon sign in the rain',
    clientRequestId: 'run-1|task:t1|0|ai.video.generate|runware|kling|hash',
    ...overrides,
  } as Parameters<ReturnType<typeof createRunwareAdapter>['submitVideoJob']>[0];
}

beforeEach(() => {
  fetchMock.mockReset();
  safeFetch.mockReset();
});

describe('the task id', () => {
  it('is a v4-shaped uuid derived from the client request id', () => {
    const uuid = runwareTaskUuid('some-client-request-id');
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('is stable across calls, so a replay addresses the job it already bought', () => {
    expect(runwareTaskUuid('abc')).toBe(runwareTaskUuid('abc'));
    expect(runwareTaskUuid('abc')).not.toBe(runwareTaskUuid('abd'));
  });

  it('is the handle the adapter reports before any call is made', () => {
    const adapter = createRunwareAdapter(CONFIG);
    expect(adapter.videoJobHandleFor('abc')).toEqual({
      providerJobId: runwareTaskUuid('abc'),
    });
  });
});

describe('submitVideoJob', () => {
  it('submits under the derived id and returns it as the handle', async () => {
    const adapter = createRunwareAdapter(CONFIG);
    const expected = runwareTaskUuid(submitRequest().clientRequestId!);
    respondWith({ data: [{ taskType: 'videoInference', taskUUID: expected }] });

    await expect(adapter.submitVideoJob(submitRequest())).resolves.toEqual({
      providerJobId: expected,
    });
    const task = sentTask();
    expect(task['taskUUID']).toBe(expected);
    expect(task['deliveryMethod']).toBe('async');
    expect(task['includeCost']).toBe(true);
  });

  it('treats a conflicting task id as the accepted submit it proves', async () => {
    const adapter = createRunwareAdapter(CONFIG);
    const expected = runwareTaskUuid(submitRequest().clientRequestId!);
    // The provider refuses a replay with HTTP 400. That status is the normal
    // shape of this success, so a transport layer that threw on it would make
    // the whole caller-assigned-handle recovery unreachable.
    respondWith(
      {
        data: [],
        errors: [{ code: 'conflictTaskUUID', message: 'already used', taskUUID: expected }],
      },
      400,
    );

    await expect(adapter.submitVideoJob(submitRequest())).resolves.toEqual({
      providerJobId: expected,
    });
  });

  it('raises a rejection that is not a conflict', async () => {
    const adapter = createRunwareAdapter(CONFIG);
    const expected = runwareTaskUuid(submitRequest().clientRequestId!);
    respondWith(
      { data: [], errors: [{ code: 'unsupportedDuration', message: 'no', taskUUID: expected }] },
      400,
    );

    await expect(adapter.submitVideoJob(submitRequest())).rejects.toMatchObject({
      providerErrorCode: 'unsupportedDuration',
      retryable: false,
    });
  });

  it('raises an auth failure rather than reading it as a rejected render', async () => {
    const adapter = createRunwareAdapter(CONFIG);
    respondWith({ data: [], errors: [{ code: 'invalidApiKey', message: 'bad key' }] }, 401);

    await expect(adapter.submitVideoJob(submitRequest())).rejects.toMatchObject({ code: 'auth' });
  });

  it('does not read another task’s failure as this one’s', async () => {
    const adapter = createRunwareAdapter(CONFIG);
    const expected = runwareTaskUuid(submitRequest().clientRequestId!);
    respondWith({
      data: [{ taskType: 'videoInference', taskUUID: expected }],
      errors: [{ code: 'invalidModel', message: 'nope', taskUUID: 'a-different-task' }],
    });

    await expect(adapter.submitVideoJob(submitRequest())).resolves.toEqual({
      providerJobId: expected,
    });
  });

  it('sends dimensions for a prompt-only render', async () => {
    const adapter = createRunwareAdapter(CONFIG);
    respondWith({ data: [{ taskUUID: runwareTaskUuid(submitRequest().clientRequestId!) }] });
    await adapter.submitVideoJob(submitRequest({ aspectRatio: '9:16' }));

    const task = sentTask();
    expect(task['width']).toBe(720);
    expect(task['height']).toBe(1280);
    expect(task['inputs']).toBeUndefined();
  });

  it('names each frame’s position and omits dimensions the frames decide', async () => {
    const adapter = createRunwareAdapter(CONFIG);
    respondWith({ data: [{ taskUUID: runwareTaskUuid(submitRequest().clientRequestId!) }] });
    await adapter.submitVideoJob(
      submitRequest({
        imageData: 'AAAA',
        imageMimeType: 'image/jpeg',
        lastFrameData: 'BBBB',
      }),
    );

    const task = sentTask();
    expect(task['inputs']).toEqual({
      frameImages: [
        { image: 'data:image/jpeg;base64,AAAA', frame: 'first' },
        { image: 'data:image/png;base64,BBBB', frame: 'last' },
      ],
    });
    expect(task['width']).toBeUndefined();
    expect(task['height']).toBeUndefined();
  });

  const frameFields = { imageData: 'AAAA', imageMimeType: 'image/png' };
  const mara = { data: 'MMMM', mimeType: 'image/png', role: 'character' as const, label: 'Mara' };
  const iven = { data: 'IIII', mimeType: 'image/png', role: 'character' as const, label: 'Iven' };

  it('carries each named reference as its own element', async () => {
    const adapter = createRunwareAdapter(CONFIG);
    respondWith({ data: [{ taskUUID: runwareTaskUuid(submitRequest().clientRequestId!) }] });
    await adapter.submitVideoJob(
      submitRequest({
        ...frameFields,
        prompt: 'Mara turns to face the rain',
        references: [mara, { ...mara, data: 'MM2' }],
      }),
    );

    const inputs = sentTask()['inputs'] as { elements: Array<Record<string, unknown>> };
    // Two images of one character are one identity, not two.
    expect(inputs.elements).toHaveLength(1);
    expect(inputs.elements[0]).toMatchObject({
      description: 'Mara',
      frontalImage: 'data:image/png;base64,MMMM',
      images: ['data:image/png;base64,MM2'],
    });
    expect(sentTask()['positivePrompt']).toBe('<<<element_1>>> turns to face the rain');
  });

  it('numbers the markers by where the prompt names them, not by argument order', async () => {
    const adapter = createRunwareAdapter(CONFIG);
    respondWith({ data: [{ taskUUID: runwareTaskUuid(submitRequest().clientRequestId!) }] });
    // The route reads its markers in order of appearance, so a reference list
    // that arrives in the other order must still line up with the prompt.
    await adapter.submitVideoJob(
      submitRequest({
        ...frameFields,
        prompt: 'Iven steps back as Mara advances',
        references: [mara, iven],
      }),
    );

    const inputs = sentTask()['inputs'] as { elements: Array<Record<string, unknown>> };
    expect(inputs.elements.map((element) => element['description'])).toEqual(['Iven', 'Mara']);
    expect(sentTask()['positivePrompt']).toBe(
      '<<<element_1>>> steps back as <<<element_2>>> advances',
    );
  });

  it('keeps the element id inside the length the route accepts', async () => {
    const adapter = createRunwareAdapter(CONFIG);
    respondWith({ data: [{ taskUUID: runwareTaskUuid(submitRequest().clientRequestId!) }] });
    await adapter.submitVideoJob(
      submitRequest({
        ...frameFields,
        prompt: 'Mara turns to face the rain',
        references: [mara],
      }),
    );
    const inputs = sentTask()['inputs'] as { elements: Array<Record<string, unknown>> };
    // The route rejects a longer id as a type error, naming neither the cap
    // nor the length — so nothing downstream would explain this failure.
    expect(String(inputs.elements[0]!['id']).length).toBeLessThanOrEqual(20);
  });

  it('always sends a non-empty image list, which the route requires', async () => {
    const adapter = createRunwareAdapter(CONFIG);
    respondWith({ data: [{ taskUUID: runwareTaskUuid(submitRequest().clientRequestId!) }] });
    await adapter.submitVideoJob(
      submitRequest({
        ...frameFields,
        prompt: 'Mara turns to face the rain',
        references: [mara],
      }),
    );
    const inputs = sentTask()['inputs'] as { elements: Array<Record<string, unknown>> };
    expect(inputs.elements[0]!['images']).toEqual(['data:image/png;base64,MMMM']);
  });

  it('gives one identity a stable id across renders', async () => {
    const adapter = createRunwareAdapter(CONFIG);
    const idOf = async (clientRequestId: string) => {
      respondWith({ data: [{ taskUUID: runwareTaskUuid(clientRequestId) }] });
      await adapter.submitVideoJob(
        submitRequest({
          ...frameFields,
          clientRequestId,
          prompt: 'Mara turns to face the rain',
          references: [mara],
        }),
      );
      const inputs = sentTask()['inputs'] as { elements: Array<Record<string, unknown>> };
      return inputs.elements[0]!['id'];
    };
    expect(await idOf('run-a')).toBe(await idOf('run-b'));
  });

  it('gives the longer name its own element when one label contains another', async () => {
    const adapter = createRunwareAdapter(CONFIG);
    respondWith({ data: [{ taskUUID: runwareTaskUuid(submitRequest().clientRequestId!) }] });
    await adapter.submitVideoJob(
      submitRequest({
        ...frameFields,
        prompt: 'Ana meets Anabel at the door',
        references: [mara, iven].map((r, i) => ({ ...r, label: ['Ana', 'Anabel'][i]! })),
      }),
    );
    // Substituting label by label would let 'Ana' eat the 'Ana' inside
    // 'Anabel', shipping Anabel's images with her name nowhere in the prompt.
    expect(sentTask()['positivePrompt']).toBe('<<<element_1>>> meets <<<element_2>>> at the door');
    const inputs = sentTask()['inputs'] as { elements: Array<Record<string, unknown>> };
    expect(inputs.elements.map((element) => element['description'])).toEqual(['Ana', 'Anabel']);
  });

  it('does not rename a label that only appears inside a longer word', async () => {
    const adapter = createRunwareAdapter(CONFIG);
    await expect(
      adapter.submitVideoJob(
        submitRequest({
          ...frameFields,
          prompt: 'the crowd fills the mall',
          references: [{ ...mara, label: 'Al' }],
        }),
      ),
    ).rejects.toThrow(/never names 'Al'/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a reference the prompt never names, rather than paying to ignore it', async () => {
    const adapter = createRunwareAdapter(CONFIG);
    await expect(
      adapter.submitVideoJob(
        submitRequest({
          ...frameFields,
          prompt: 'a figure turns to face the rain',
          references: [mara],
        }),
      ),
    ).rejects.toThrow(/never names 'Mara'/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses references on a render that starts from the prompt alone', async () => {
    const adapter = createRunwareAdapter(CONFIG);
    // The route accepts this request and renders without the elements, so the
    // refusal has to happen here rather than at the provider.
    await expect(
      adapter.submitVideoJob(
        submitRequest({ prompt: 'Mara turns to face the rain', references: [mara] }),
      ),
    ).rejects.toThrow(/only when the clip starts from a frame/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a clip length the route does not render, before it is billed', async () => {
    const adapter = createRunwareAdapter(CONFIG);
    await expect(adapter.submitVideoJob(submitRequest({ durationSeconds: 30 }))).rejects.toThrow(
      /3–15 seconds/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an aspect ratio the route does not render', async () => {
    const adapter = createRunwareAdapter(CONFIG);
    await expect(adapter.submitVideoJob(submitRequest({ aspectRatio: '21:9' }))).rejects.toThrow(
      /'21:9' is not among them/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not call the provider when the run is already cancelled', async () => {
    const adapter = createRunwareAdapter(CONFIG);
    const aborted = AbortSignal.abort();
    // A listener on an already-aborted signal never fires, so nothing downstream
    // would have stopped this submit from buying a render after cancellation.
    await expect(adapter.submitVideoJob(submitRequest({ signal: aborted }))).rejects.toThrow(
      /cancelled/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a submit it cannot address, rather than minting an id no replay can find', async () => {
    const adapter = createRunwareAdapter(CONFIG);
    const { clientRequestId: _omitted, ...withoutId } = submitRequest() as Record<string, unknown>;
    await expect(adapter.submitVideoJob(withoutId as never)).rejects.toThrow(
      /no client request id/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a resolution the route does not render', async () => {
    const adapter = createRunwareAdapter(CONFIG);
    await expect(adapter.submitVideoJob(submitRequest({ resolution: '1080p' }))).rejects.toThrow(
      /renders 720p/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a model that is not a wired route', async () => {
    const adapter = createRunwareAdapter(CONFIG);
    await expect(
      adapter.submitVideoJob(submitRequest({ model: 'someone:else@1' })),
    ).rejects.toThrow(/not a wired Runware video route/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('pollVideoJob', () => {
  const handle = { providerJobId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
  const pollRequest = { handle, model: MODEL, durationSeconds: 5 };

  it('reports a running render as pending', async () => {
    const adapter = createRunwareAdapter(CONFIG);
    respondWith({ data: [{ taskUUID: handle.providerJobId, status: 'processing', progress: 40 }] });
    await expect(adapter.pollVideoJob(pollRequest)).resolves.toEqual({ status: 'pending' });
  });

  it('reports an id the provider does not recognise as pending, never as missing', async () => {
    const adapter = createRunwareAdapter(CONFIG);
    respondWith({ data: [] });
    // A never-submitted id and a running one are answered identically, and only
    // one of those would be safe to conclude.
    await expect(adapter.pollVideoJob(pollRequest)).resolves.toEqual({ status: 'pending' });
  });

  it('carries the cost the provider reports', async () => {
    const adapter = createRunwareAdapter(CONFIG);
    respondWith({
      data: [
        {
          taskUUID: handle.providerJobId,
          status: 'success',
          cost: 0.42,
          videoURL: 'https://vm.runware.ai/video/os/a/ws/5/vi/x.mp4',
        },
      ],
    });
    safeFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'video/mp4' }),
      arrayBuffer: async () => new TextEncoder().encode('mp4-bytes').buffer,
    });

    const poll = await adapter.pollVideoJob(pollRequest);
    expect(poll.status).toBe('succeeded');
    if (poll.status !== 'succeeded') return;
    expect(poll.response.reportedCost).toEqual({ currency: 'USD', micros: 420_000 });
    expect(poll.response.videos[0]?.mimeType).toBe('video/mp4');
  });

  it('does not read a reported cost of zero as a price', async () => {
    const adapter = createRunwareAdapter(CONFIG);
    respondWith({
      data: [
        {
          taskUUID: handle.providerJobId,
          status: 'success',
          cost: 0,
          videoURL: 'https://vm.runware.ai/video/os/a/ws/5/vi/x.mp4',
        },
      ],
    });
    safeFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'video/mp4' }),
      arrayBuffer: async () => new TextEncoder().encode('mp4').buffer,
    });

    const poll = await adapter.pollVideoJob(pollRequest);
    // Falling through to the catalog rate reports what the render is worth;
    // taking the zero would settle a paid render as free.
    expect(poll.status === 'succeeded' && poll.response.reportedCost).toBeUndefined();
  });

  it('reports a failure that arrives in the errors array', async () => {
    const adapter = createRunwareAdapter(CONFIG);
    respondWith({
      data: [],
      errors: [
        {
          code: 'timeoutProvider',
          message: 'The external provider did not respond',
          taskUUID: handle.providerJobId,
        },
      ],
    });
    await expect(adapter.pollVideoJob(pollRequest)).resolves.toEqual({
      status: 'failed',
      message: 'The external provider did not respond',
    });
  });

  it('raises a refused read rather than retiring the render it could not read', async () => {
    const adapter = createRunwareAdapter(CONFIG);
    respondWith({ errors: [{ code: 'invalidApiKey', message: 'bad key' }] }, 401);
    // The render is still running and already paid for. Reporting this as a
    // failed render would settle a job on the strength of our own bad key.
    await expect(adapter.pollVideoJob(pollRequest)).rejects.toMatchObject({ code: 'auth' });
  });

  it('reports a throttled poll as retryable, never as a verdict', async () => {
    const adapter = createRunwareAdapter(CONFIG);
    respondWith({ errors: [{ code: 'rateLimit', message: 'slow down' }] }, 429);
    await expect(adapter.pollVideoJob(pollRequest)).rejects.toMatchObject({
      code: 'rate_limit',
      retryable: true,
    });
  });

  it('refuses to read a render served from a host that does not serve results', async () => {
    const adapter = createRunwareAdapter(CONFIG);
    respondWith({
      data: [
        {
          taskUUID: handle.providerJobId,
          status: 'success',
          videoURL: 'https://attacker.example/x.mp4',
        },
      ],
    });
    safeFetch.mockRejectedValueOnce(new Error('host not allowed'));
    await expect(adapter.pollVideoJob(pollRequest)).rejects.toBeInstanceOf(AIClientError);
  });
});

describe('the text lane', () => {
  it('refuses by name rather than answering emptily', async () => {
    const adapter = createRunwareAdapter(CONFIG);
    expect(() => adapter.generateText({ model: 'x', messages: [] })).toThrow(
      /serves no text model/,
    );
  });
});
