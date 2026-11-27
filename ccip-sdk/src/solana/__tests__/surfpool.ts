/**
 * Surfpool fork harness shared by the Solana fork suites (`solana/fork.test.ts`, `cct/solana/onboarding.fork.test.ts`).
 *
 * Surfpool forks a live cluster into a local SVM that lazily clones accounts on first read, and
 * exposes `surfnet_*` cheatcodes to overwrite accounts. Suites start one instance per describe
 * block, on a port of their own.
 */
import { type ChildProcess, execSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'

import { Connection, SYSVAR_RENT_PUBKEY } from '@solana/web3.js'

/** Mirrors Surfpool's output to the console when set. */
export const VERBOSE = !!process.env.VERBOSE

export interface SurfpoolInstance {
  host: string
  port: number
  start(): Promise<void>
  stop(): Promise<void>
}

export function isSurfpoolAvailable(): boolean {
  try {
    execSync('surfpool --version', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function createSurfpoolInstance({
  rpcUrl,
  network = 'mainnet',
  host = '127.0.0.1',
  port = 8899,
}: {
  rpcUrl?: string
  network?: 'devnet' | 'mainnet' | 'testnet'
  port?: number
  host?: string
} = {}): SurfpoolInstance {
  let child: ChildProcess | undefined

  return {
    host,
    port,
    async start() {
      const args = [
        'start',
        '--port',
        String(port),
        '--host',
        host,
        '--no-tui',
        '--no-studio',
        '--no-deploy',
        '--ws-port',
        String(port + 1),
        // Surfpool 1.6+ binds a TPU QUIC port (8004 by default): let the OS pick one, so several
        // forks (other suites, other sessions) run side by side
        '--tpu-quic-port',
        '0',
      ]
      if (rpcUrl) {
        args.push('--rpc-url', rpcUrl)
      } else {
        args.push('--network', network)
      }

      const proc = spawn('surfpool', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      child = proc

      // The newest output lines, shown if the fork dies: the tests themselves then only see
      // ECONNREFUSED from every later request.
      const tail: string[] = []
      const keep = (data: Buffer) => {
        tail.push(...String(data).split('\n').filter(Boolean))
        tail.splice(0, tail.length - 40)
      }
      proc.stdout.on('data', (data: Buffer) => {
        keep(data)
        if (VERBOSE) process.stdout.write(`[surfpool] ${String(data)}`)
      })
      proc.stderr.on('data', (data: Buffer) => {
        keep(data)
        if (VERBOSE) process.stderr.write(`[surfpool] ${String(data)}`)
      })
      proc.on('exit', (code, signal) => {
        if (child !== proc) return // stopped by stop()
        child = undefined
        console.error(
          `surfpool on port ${port} exited unexpectedly (code ${code}, signal ${signal}); last output:\n` +
            tail.map((line) => `  [surfpool] ${line}`).join('\n'),
        )
      })

      // Wait for RPC to become ready
      const url = `http://${host}:${port}`
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        if (child !== proc) throw new Error(`Surfpool exited before it served ${url}`)
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getVersion', params: [] }),
          })
          if (res.ok) return
        } catch {
          // not ready yet
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      throw new Error(`Surfpool did not become ready within 60s at ${url}`)
    },

    async stop() {
      if (!child) return
      const proc = child
      child = undefined

      return new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          proc.kill('SIGKILL')
          resolve()
        }, 5_000)

        proc.on('exit', () => {
          clearTimeout(timeout)
          resolve()
        })

        proc.kill('SIGTERM')
      })
    },
  }
}

/**
 * Tears down the web3.js websocket BEFORE stopping surfpool. Sends confirm through it
 * (connection.confirmTransaction), and web3.js hands its client `max_reconnects: Infinity` — once
 * surfpool is gone the client would retry the dead socket every second forever, keeping the test
 * process alive long after every test has passed. There is no public accessor for the client, so
 * this pokes the private field, but only through its public CommonClient API
 * (setAutoReconnect/close).
 */
export function closeWebSocket(connection: Connection | undefined) {
  const wsClient = (
    connection as unknown as
      | {
          _rpcWebSocket?: {
            setAutoReconnect?: (enable: boolean) => void
            close?: (code?: number, data?: string) => void
          }
        }
      | undefined
  )?._rpcWebSocket
  wsClient?.setAutoReconnect?.(false)
  try {
    wsClient?.close?.(1000, 'fork tests done')
  } catch {
    // socket already gone
  }
}

/** Sends a raw JSON-RPC request to the fork, for the `surfnet_*` cheatcodes web3.js doesn't wrap. */
export async function surfnetRequest(
  connection: Connection,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const res = await fetch(connection.rpcEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = (await res.json()) as { result?: unknown; error?: { message: string } }
  if (body.error) throw new Error(`${method} failed: ${body.error.message}`)
  return body.result
}

/**
 * Copies the upstream rent sysvar into the fork. Surfpool synthesizes rent from its local SVM
 * defaults instead of cloning the cluster's sysvar, so accounts created upstream can fail Anchor's
 * rent-exemption check on the fork.
 */
export async function syncRentSysvar(fork: Connection, upstreamUrl: string): Promise<void> {
  const rent = await new Connection(upstreamUrl, 'confirmed').getAccountInfo(SYSVAR_RENT_PUBKEY)
  if (!rent) throw new Error('upstream rent sysvar not found')
  await surfnetRequest(fork, 'surfnet_setAccount', [
    SYSVAR_RENT_PUBKEY.toBase58(),
    {
      data: rent.data.toString('hex'),
      lamports: rent.lamports,
      owner: rent.owner.toBase58(),
      executable: rent.executable,
    },
  ])
  const forkRent = await fork.getAccountInfo(SYSVAR_RENT_PUBKEY)
  if (!forkRent?.data.equals(rent.data)) throw new Error('fork rent sysvar does not match upstream')
}

/**
 * Starts Surfpool forking `upstreamUrl` and connects to it, with the upstream rent settings.
 * Call {@link stopFork} in `after`.
 */
export async function startFork({
  upstreamUrl,
  port,
}: {
  upstreamUrl: string
  /** Preferred RPC port (the websocket takes the next one); a taken pair falls back to a free one. */
  port?: number
}): Promise<{ surfpool: SurfpoolInstance; connection: Connection }> {
  // several sessions run forks on one machine: a fixed port collides
  const free = port !== undefined && (await portFree(port)) && (await portFree(port + 1))
  const surfpool = createSurfpoolInstance({
    rpcUrl: upstreamUrl,
    port: free ? port : await freePortPair(),
  })
  await surfpool.start()
  const connection = new Connection(`http://${surfpool.host}:${surfpool.port}`, {
    commitment: 'confirmed',
    wsEndpoint: `ws://${surfpool.host}:${surfpool.port + 1}`,
  })
  await syncRentSysvar(connection, upstreamUrl)
  return { surfpool, connection }
}

/** Whether `port` can be bound on 127.0.0.1 right now. */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

/** A port the OS reports free whose successor is free too (RPC and websocket). */
async function freePortPair(): Promise<number> {
  for (;;) {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    await new Promise((resolve) => server.close(resolve))
    const port = typeof address === 'object' && address ? address.port : 0
    if (port && port < 65_535 && (await portFree(port + 1))) return port
  }
}

/** How long a stop waits for web3.js confirmation polls still in flight to settle. */
const SETTLE_MS = 1_500

/**
 * Closes the fork's websocket, then stops Surfpool; see {@link closeWebSocket}. A web3.js
 * `confirmTransaction` can leave one block-height poll in flight after it resolves: the stop waits
 * for it first, so no fetch fails after the suite ended.
 */
export async function stopFork(fork: {
  surfpool?: SurfpoolInstance
  connection?: Connection
}): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
  closeWebSocket(fork.connection)
  await fork.surfpool?.stop()
}
