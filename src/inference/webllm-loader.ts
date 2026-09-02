import { MODEL_ID } from './prompt'

export interface ChatCompletionChunk {
  choices?: Array<{ delta?: { content?: string } }>
}

export interface ChatEngine {
  chat: {
    completions: {
      create: (input: {
        messages: Array<{ role: 'user' | 'system'; content: string }>
        temperature?: number
        max_tokens?: number
        stream: true
        response_format?: { type: 'json_object'; schema: string }
      }) => Promise<AsyncIterable<ChatCompletionChunk>>
    }
  }
  unload?: () => Promise<void>
  interruptGenerate?: () => void | Promise<void>
  /** Full teardown: releases model memory and stops the worker thread. */
  dispose?: () => Promise<void>
}

interface WebLlmModule {
  CreateMLCEngine: (
    modelId: string,
    opts?: { initProgressCallback?: (report: { text: string }) => void },
  ) => Promise<EngineLike>
  CreateWebWorkerMLCEngine: (
    worker: Worker,
    modelId: string,
    opts?: { initProgressCallback?: (report: { text: string }) => void },
  ) => Promise<EngineLike>
}

type CompletionCreate = ChatEngine['chat']['completions']['create']

interface EngineLike {
  chat: { completions: { create: CompletionCreate } }
  unload: () => Promise<void>
  interruptGenerate?: () => void | Promise<void>
}

/** Thrown when an activation is deliberately abandoned mid-load. */
export class ActivationAbortedError extends Error {
  constructor() {
    super('activation-aborted')
    this.name = 'ActivationAbortedError'
  }
}

/**
 * Loads the WebLLM engine with ABORT OWNERSHIP. A stalled or cancelled
 * activation must never leak a worker thread or GPU context, even when the
 * runtime's creation promise would never settle on its own:
 *
 * - the caller's AbortSignal is checked before and after the runtime import;
 * - aborting terminates the Web Worker immediately and rejects promptly;
 * - a deliberate abort SKIPS the main-thread fallback;
 * - any engine whose creation resolves AFTER an abort wins the race is
 *   unloaded (and its thread terminated) instead of being adopted.
 */
export async function loadWebLlmEngine(
  onProgress?: (text: string) => void,
  signal?: AbortSignal,
): Promise<ChatEngine> {
  // Loader contract: an already-aborted activation is observable immediately,
  // without waiting for any import scheduling.
  if (signal?.aborted) throw new ActivationAbortedError()

  const webllm = (await import('@mlc-ai/web-llm')) as unknown as WebLlmModule

  // The dynamic import yields to the microtask queue; an abort may have fired
  // while it was in flight.
  if (signal?.aborted) throw new ActivationAbortedError()

  const progress = (report: { text: string }) => {
    if (!signal?.aborted) onProgress?.(report.text)
  }

  let worker: Worker | null = null

  const terminateWorker = () => {
    try {
      worker?.terminate()
    } catch {
      // Termination is best-effort; the deterministic board is unaffected.
    }
    worker = null
  }

  /**
   * Races a runtime creation promise against the abort signal. When abort
   * wins, ANY engine the creation promise produces later is unloaded exactly
   * once here — never adopted, never leaked.
   */
  const raceWithAbort = (create: Promise<EngineLike>, onAbortTerminate: () => void): Promise<EngineLike> => {
    if (!signal) return create
    return new Promise<EngineLike>((resolve, reject) => {
      let settled = false
      const finishSettled = () => {
        settled = true
        signal.removeEventListener('abort', onAbort)
      }
      const releaseLate = (engine: EngineLike | undefined) => {
        if (engine) {
          void engine.unload().catch(() => {})
        }
        onAbortTerminate()
      }
      const onAbort = () => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        onAbortTerminate()
        reject(new ActivationAbortedError())
      }
      signal.addEventListener('abort', onAbort, { once: true })
      // The ONE settlement handler owns late cleanup: if abort already won,
      // a resolving engine is unloaded exactly once here.
      create.then(
        (engine) => {
          if (settled) {
            releaseLate(engine)
            return
          }
          finishSettled()
          resolve(engine)
        },
        (error) => {
          if (settled) {
            onAbortTerminate()
            return
          }
          finishSettled()
          reject(error)
        },
      )
    })
  }

  try {
    worker = new Worker(new URL('./webllm.worker.ts', import.meta.url), { type: 'module' })
    const activeWorker = worker
    const inner = await raceWithAbort(
      webllm.CreateWebWorkerMLCEngine(activeWorker, MODEL_ID, { initProgressCallback: progress }),
      terminateWorker,
    )
    return wrapEngine(inner, () => activeWorker.terminate())
  } catch (workerError) {
    // Worker construction can succeed even when engine initialisation fails;
    // never leave that orphan thread alive before trying the main thread.
    terminateWorker()
    if (workerError instanceof ActivationAbortedError) throw workerError

    const inner = await raceWithAbort(
      webllm.CreateMLCEngine(MODEL_ID, { initProgressCallback: progress }),
      () => {},
    )
    return wrapEngine(inner)
  }
}

/** Delegating wrapper so disposal can also stop the worker thread. */
function wrapEngine(inner: EngineLike, terminateWorker?: () => void): ChatEngine {
  return {
    chat: {
      completions: {
        create: (input) => inner.chat.completions.create(input),
      },
    },
    interruptGenerate: () => inner.interruptGenerate?.(),
    unload: () => inner.unload(),
    dispose: async () => {
      try {
        await inner.unload()
      } catch {
        // The worker still must not survive a failed unload.
      }
      terminateWorker?.()
    },
  }
}
