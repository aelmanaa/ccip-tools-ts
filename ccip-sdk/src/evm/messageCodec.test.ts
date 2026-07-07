import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ZeroHash, dataLength } from 'ethers'

import { type MessageV1, encodeMessageV1, encodeTokenTransferV1 } from './messageCodec.ts'

// Golden vectors captured against the on-chain getCCVsForMessage(bytes) view on Avalanche Fuji (a
// Sepolia -> Fuji candidate). ENC2 is ENC0 with the 4-byte finality field flipped 0x00000000 ->
// 0x00000002. Matching these byte-for-byte confirms the encoder matches MessageV1Codec._encodeMessageV1.
const ENC0 =
  '0x01de41ba4fc9d91ad9ccf0a31a221f3c9b00000000000000000000000000030d4000000000000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000014e60c1d654283252623e448f53f648663a701cd7b20000000000000000000000000000000000000000000000000000000000000000014161d23c30b5ae2899c3d4d969ba2b82026f3954a00000000000f68656c6c6f2d707265666c69676874'
const ENC2 =
  '0x01de41ba4fc9d91ad9ccf0a31a221f3c9b00000000000000000000000000030d4000000002000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000014e60c1d654283252623e448f53f648663a701cd7b20000000000000000000000000000000000000000000000000000000000000000014161d23c30b5ae2899c3d4d969ba2b82026f3954a00000000000f68656c6c6f2d707265666c69676874'

// Sepolia -> Fuji, data-only ("hello-preflight"), 200k ccipReceive gas, source addrs abi.encoded(0),
// dest OffRamp/receiver raw 20 bytes. Matches the decoded ENC0 fields exactly.
function baseCandidate(): MessageV1 {
  return {
    sourceChainSelector: 16015286601757825753n,
    destChainSelector: 14767482510784806043n,
    messageNumber: 0n,
    executionGasLimit: 0,
    ccipReceiveGasLimit: 200000,
    finality: '0x00000000',
    ccvAndExecutorHash: ZeroHash,
    onRampAddress: ZeroHash, // abi.encode(address(0)) = 32 zero bytes
    offRampAddress: '0xe60c1d654283252623e448f53f648663a701cd7b',
    sender: ZeroHash, // abi.encode(address(0)) = 32 zero bytes
    receiver: '0x161d23c30b5ae2899c3d4d969ba2b82026f3954a',
    data: '0x68656c6c6f2d707265666c69676874', // "hello-preflight"
  }
}

describe('encodeMessageV1 golden vectors', () => {
  it('reproduces the finalized (finality=0) data-only candidate byte-for-byte (ENC0)', () => {
    assert.equal(encodeMessageV1(baseCandidate()), ENC0)
  })

  it('reproduces the finality=2 candidate byte-for-byte (ENC2 = ENC0 with finality flipped)', () => {
    assert.equal(encodeMessageV1({ ...baseCandidate(), finality: '0x00000002' }), ENC2)
  })

  it('the only difference between ENC0 and ENC2 is the 4-byte finality field', () => {
    const enc0 = encodeMessageV1(baseCandidate())
    const enc2 = encodeMessageV1({ ...baseCandidate(), finality: '0x00000002' })
    assert.equal(enc0.length, enc2.length)
    let diffs = 0
    for (let i = 0; i < enc0.length; i++) if (enc0[i] !== enc2[i]) diffs++
    assert.equal(diffs, 1) // single nibble: ...0000000[0] vs ...0000000[2]
  })
})

describe('encodeMessageV1 structure', () => {
  it('header is the fixed 69 bytes before any variable field', () => {
    // version(1)+srcSel(8)+dstSel(8)+msgNumber(8)+execGas(4)+ccipReceiveGas(4)+finality(4)+ccvHash(32)
    const enc = encodeMessageV1(baseCandidate())
    const header = 1 + 8 + 8 + 8 + 4 + 4 + 4 + 32
    // First length-prefix byte (onRampAddressLength) sits right after the header.
    assert.equal(dataLength(enc) > header, true)
  })

  it('defaults omit optional fields: empty onRamp/offRamp/destBlob get a zero length prefix', () => {
    const minimal: MessageV1 = {
      sourceChainSelector: 1n,
      destChainSelector: 2n,
      ccipReceiveGasLimit: 0,
      finality: '0x00000000',
      sender: ZeroHash,
      receiver: '0x161d23c30b5ae2899c3d4d969ba2b82026f3954a',
    }
    const enc = encodeMessageV1(minimal)
    // 69-byte header + onRampLen(1,=0) + offRampLen(1,=0) + senderLen(1)+sender(32) +
    // receiverLen(1)+receiver(20) + destBlobLen(2,=0) + tokenTransferLen(2,=0) + dataLen(2,=0)
    assert.equal(dataLength(enc), 69 + 1 + 1 + 1 + 32 + 1 + 20 + 2 + 2 + 2)
  })

  it('a token transfer is appended with a non-zero uint16 length prefix', () => {
    const withToken = encodeMessageV1({
      ...baseCandidate(),
      data: '0x',
      tokenTransfer: {
        amount: 1_000_000_000n,
        destTokenAddress: '0x161d23c30b5ae2899c3d4d969ba2b82026f3954a',
      },
    })
    const dataOnly = encodeMessageV1({ ...baseCandidate(), data: '0x' })
    assert.equal(dataLength(withToken) > dataLength(dataOnly), true)
  })
})

describe('encodeTokenTransferV1', () => {
  it('starts with version byte 1 and the 32-byte amount', () => {
    const enc = encodeTokenTransferV1({
      amount: 255n,
      destTokenAddress: '0x161d23c30b5ae2899c3d4d969ba2b82026f3954a',
    })
    // version(1) + amount(32) => amount 255 lands in the last byte of the 32-byte word
    assert.equal(enc.slice(0, 4), '0x01') // version = 1
    assert.equal(
      enc.slice(4, 4 + 64),
      '00000000000000000000000000000000000000000000000000000000000000ff',
    )
  })
})

// Full-fidelity vector: a REAL sent v2 PTT message (Base Sepolia -> Sepolia, messageId
// 0x4af0691181ca44363ce5252524041a232504fe8ec4d83832724d4f0223ce67bd). Its on-chain encodedMessage
// (from the CCIPMessageSent event) is reproduced byte-for-byte from the decoded wire fields, exercising
// the non-zero onRamp/messageNumber/ccvAndExecutorHash/token paths the candidate vectors zero-fill.
const REAL_PTT_ENCODED =
  '0x018f90b8876dee6538de41ba4fc9d91ad9000000000000009c000c537800030d4000000001fa26d827ff845fc9ee6784788bdd5ece8aca307838a4cfbce498c5492ac5d18820000000000000000000000000829f4e6e2b979a4b87ecf493be94e25087aa0fcd14386577d8350d5814198974d16c3c756a638fbd62200000000000000000000000009d087fc03ae39b088326b67fa3c788236645b71714d52bda0535846fcd0e6e18c9a6a496e2f30420be000000af010000000000000000000000000000000000000000000000000d99a8cec7e2000020000000000000000000000000870d224b7e0afed242d310978e44580be4463ace20000000000000000000000000d2b2e09fb55adeca3136f5824e97bf66398aba6214798f93eff9dc706d1decaa5d6ae52527c163d59c14d52bda0535846fcd0e6e18c9a6a496e2f30420be0020000000000000000000000000000000000000000000000000000000000000001200200000000000000000000000009d087fc03ae39b088326b67fa3c788236645b717'

describe('encodeMessageV1 full-fidelity (real sent v2 message)', () => {
  it('reproduces a real PTT encodedMessage byte-for-byte (all fields non-zero)', () => {
    const message: MessageV1 = {
      sourceChainSelector: 10344971235874465080n,
      destChainSelector: 16015286601757825753n,
      messageNumber: 156n,
      executionGasLimit: 807800,
      ccipReceiveGasLimit: 200000,
      finality: '0x00000001',
      ccvAndExecutorHash: '0xfa26d827ff845fc9ee6784788bdd5ece8aca307838a4cfbce498c5492ac5d188',
      onRampAddress: '0x000000000000000000000000829f4e6e2b979a4b87ecf493be94e25087aa0fcd',
      offRampAddress: '0x386577d8350d5814198974d16c3c756a638fbd62',
      sender: '0x0000000000000000000000009d087fc03ae39b088326b67fa3c788236645b717',
      receiver: '0xd52bda0535846fcd0e6e18c9a6a496e2f30420be',
      data: '0x0000000000000000000000009d087fc03ae39b088326b67fa3c788236645b717',
      tokenTransfer: {
        amount: 980000000000000000n,
        sourcePoolAddress: '0x000000000000000000000000870d224b7e0afed242d310978e44580be4463ace',
        sourceTokenAddress: '0x000000000000000000000000d2b2e09fb55adeca3136f5824e97bf66398aba62',
        destTokenAddress: '0x798f93eff9dc706d1decaa5d6ae52527c163d59c',
        tokenReceiver: '0xd52bda0535846fcd0e6e18c9a6a496e2f30420be',
        extraData: '0x0000000000000000000000000000000000000000000000000000000000000012',
      },
    }
    assert.equal(encodeMessageV1(message), REAL_PTT_ENCODED)
  })
})
