import type { Idl } from '@coral-xyz/anchor'

/**
 * CCIP 2.0 Solana receiver interface fragment: the `ccip_receive_v2` entrypoint the 2.0 OffRamp
 * calls on receivers registered as v2 in the Router's `ReceiverRegistry`, and that registry account.
 *
 * The account layout of `ccip_receive_v2` matches v1 `ccip_receive`; the payload does not: a v2
 * message carries at most one token transfer, as `Option<TokenTransfer>` (with the token receiver
 * and its usage) instead of v1's `token_amounts: Vec<SVMTokenAmount>`. Mirrors
 * `ccip-offramp` `Any2SVMMessageV2` and `ccip-common` `router_accounts::ReceiverRegistry`
 * (Router-owned PDA seeded `[b"receiver_registry", receiver_program]`).
 */
export const IDL = {
  version: '2.0.0',
  name: 'ccip_receiver_v2',
  instructions: [
    {
      name: 'ccipReceiveV2',
      accounts: [
        { name: 'authority', isMut: false, isSigner: true },
        { name: 'offrampProgram', isMut: false, isSigner: false },
        { name: 'allowedOfframp', isMut: false, isSigner: false },
      ],
      args: [{ name: 'message', type: { defined: 'Any2SVMMessageV2' } }],
    },
  ],
  accounts: [
    {
      name: 'ReceiverRegistry',
      type: {
        kind: 'struct',
        fields: [
          { name: 'bump', type: 'u8' },
          { name: 'version', type: 'u8' },
          { name: 'receiverProgram', type: 'publicKey' },
          { name: 'receiverVersion', type: 'u8' },
        ],
      },
    },
  ],
  types: [
    {
      name: 'Any2SVMMessageV2',
      type: {
        kind: 'struct',
        fields: [
          { name: 'messageId', type: { array: ['u8', 32] } },
          { name: 'sourceChainSelector', type: 'u64' },
          { name: 'sender', type: 'bytes' },
          { name: 'data', type: 'bytes' },
          { name: 'tokenTransfer', type: { option: { defined: 'TokenTransfer' } } },
        ],
      },
    },
    {
      name: 'TokenTransfer',
      type: {
        kind: 'struct',
        fields: [
          { name: 'tokenAmount', type: { defined: 'SVMTokenAmount' } },
          { name: 'tokenReceiver', type: 'publicKey' },
          { name: 'tokenReceiverUsage', type: { defined: 'SVMTokenReceiverUsage' } },
        ],
      },
    },
    {
      name: 'SVMTokenAmount',
      type: {
        kind: 'struct',
        fields: [
          { name: 'token', type: 'publicKey' },
          { name: 'amount', type: 'u64' },
        ],
      },
    },
    {
      name: 'SVMTokenReceiverUsage',
      type: {
        kind: 'enum',
        variants: [
          { name: 'DeriveAtaAndCreate' },
          { name: 'DeriveAtaDontCreate' },
          { name: 'UseAsIs' },
        ],
      },
    },
  ],
} as const satisfies Idl
