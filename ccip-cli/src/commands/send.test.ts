import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ChainFamily } from '@chainlink/ccip-sdk/src/index.ts'

import { DEFAULT_ESTIMATE_MARGIN_PERCENT, resolveReceiveLimit } from './send.ts'

describe('resolveReceiveLimit', () => {
  it('sends the estimate plus margin with --estimate-gas-limit (EVM gasLimit)', () => {
    const res = resolveReceiveLimit({
      destFamily: ChainFamily.EVM,
      extraArgs: { allowOutOfOrderExecution: true },
      estimated: 61807,
      marginPercent: 300,
      explicit: true,
      defaultLimit: 200_000n,
    })
    // the printed "61807 + 300 % = 247228" is what the message carries
    assert.equal(res.limit, 247228n)
    assert.equal(res.source, 'estimate')
    assert.deepEqual(res.extraArgs, { allowOutOfOrderExecution: true, gasLimit: 247228n })
  })

  it('sends the estimate even below the default with --estimate-gas-limit', () => {
    const res = resolveReceiveLimit({
      destFamily: ChainFamily.EVM,
      extraArgs: {},
      estimated: 43755,
      marginPercent: 10,
      explicit: true,
      defaultLimit: 200_000n,
    })
    assert.equal(res.extraArgs['gasLimit'], 48131n)
  })

  it('writes computeUnits for a Solana destination', () => {
    const res = resolveReceiveLimit({
      destFamily: ChainFamily.Solana,
      extraArgs: { tokenReceiver: 'x' },
      estimated: 780693,
      marginPercent: 20,
      explicit: true,
      defaultLimit: 200_000n,
    })
    assert.equal(res.field, 'computeUnits')
    assert.deepEqual(res.extraArgs, { tokenReceiver: 'x', computeUnits: 936832n })
  })

  it('keeps a user-set limit (--gas-limit or --extra) over the estimate', () => {
    for (const extraArgs of [{ gasLimit: 300_000n }, { computeUnits: 300_000n }]) {
      const res = resolveReceiveLimit({
        destFamily: ChainFamily.Solana,
        extraArgs,
        estimated: 1_000_000,
        marginPercent: DEFAULT_ESTIMATE_MARGIN_PERCENT,
        explicit: false,
        defaultLimit: 200_000n,
      })
      assert.equal(res.source, 'user')
      assert.equal(res.limit, 300_000n)
      assert.equal(res.extraArgs, extraArgs)
    }
  })

  it('default path: keeps the default when the estimate fits in it', () => {
    const res = resolveReceiveLimit({
      destFamily: ChainFamily.EVM,
      extraArgs: {},
      estimated: 43755,
      marginPercent: DEFAULT_ESTIMATE_MARGIN_PERCENT,
      explicit: false,
      defaultLimit: 200_000n,
    })
    assert.equal(res.source, 'default')
    assert.equal(res.limit, 200_000n)
    assert.deepEqual(res.extraArgs, {})
  })

  it('default path: raises the limit when the receiver needs more than the default', () => {
    const res = resolveReceiveLimit({
      destFamily: ChainFamily.EVM,
      extraArgs: {},
      estimated: 775456,
      marginPercent: DEFAULT_ESTIMATE_MARGIN_PERCENT,
      explicit: false,
      defaultLimit: 200_000n,
    })
    assert.equal(res.source, 'estimate')
    assert.equal(res.extraArgs['gasLimit'], 853002n)
  })

  it('default path: a token-only message (estimate 0, default 0) stays at 0', () => {
    const res = resolveReceiveLimit({
      destFamily: ChainFamily.EVM,
      extraArgs: {},
      estimated: 0,
      marginPercent: DEFAULT_ESTIMATE_MARGIN_PERCENT,
      explicit: false,
      defaultLimit: 0n,
    })
    assert.equal(res.source, 'default')
    assert.deepEqual(res.extraArgs, {})
  })

  it('default path: leaves extraArgs alone when the default limit is unknown', () => {
    const res = resolveReceiveLimit({
      destFamily: ChainFamily.EVM,
      extraArgs: {},
      estimated: 900_000,
      marginPercent: DEFAULT_ESTIMATE_MARGIN_PERCENT,
      explicit: false,
      defaultLimit: undefined,
    })
    assert.equal(res.source, 'default')
    assert.deepEqual(res.extraArgs, {})
  })
})
