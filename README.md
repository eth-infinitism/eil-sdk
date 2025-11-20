# Ethereum Interop Layer (EIL) SDK

The **Ethereum Interoperability Layer** is a trust-minimized, account-based interop layer focused on unifying the Layer 2 (L2) experience on Ethereum. It enables seamless, trustless single-signature, cross-chain User Operations without compromising on Ethereum's core values: Censorship Resistance, Open Source, Privacy, and Security.

This SDK provides the necessary tools and libraries to integrate EIL into wallets and dApps, allowing users to execute complex multi-chain operations as if they were performing a single transaction on one unified network.

## Key Features of the EIL SDK

The EIL SDK is designed to abstract away the friction of L2 fragmentation, such as managing gas on multiple chains, bridging assets, signing numerous transactions, trusting fast bridges, confusing wrong chain addresses, configuring new chains in your wallet, etc.

### Trustless Interoperability

EIL operates without forcing users to trust third parties with their funds or and intentions.
All value and state transfers are fully verifiable on-chain, with instant confirmation for the users and unbreakable dispute resolution directly on Layer 1.

### Single-Signature Cross-Chain Operations

EIL leverages an ERC-4337 Account Abstraction for multi-chain use cases.
Users can sign a single authorization to execute a series of batched calls across any number of interconnected L2s, creating a multi-chain batch operation.

### Cross-Chain Gas Payment

EIL allows using any ERC-4337 Paymaster on the source chain, and users can select any chain for the gas payment.
Cross-Chain Liquidity Providers (XLPs) front the gas fees on all destination chains and are reimbursed atomically within the EIL transaction flow.

### Multi-Chain Execution Handling

The EIL SDK handles the full flow of the Multi-Chain Execution, handling XLP selection, Voucher application and error handling.
It can be adopted by dapps and wallets alike to provide the EIL experience to their users.

## 🛠️ When to Use EIL?

EIL is ideal for applications and users who need to:

* Execute calls on multiple chains seamlessly within a single logical operation.

* Use assets scattered across different chains without the friction of bridging.

* Transact across chains without holding gas funds on every chain involved.

* Require trustless, decentralized, and censorship-resistant cross-chain execution.

## 💻 Installation

```
# Install the EIL SDK
yarn add @eth-infinitism/eil-sdk
```

## 📖 Usage

### Alice uses 90 USDC on Optimism to buy an NFT on Arbitrum

With the EIL SDK, this entire sequence is bundled into a single EIL UserOp and authorized with one signature:

```TypeScript
import { CrossChainSdk, TransferAction, ApproveAction, FunctionCallAction } from '@eth-infinitism/eil-sdk'

  const sdk = new CrossChainSdk()
  const builder = sdk.createBuilder()

  const usdc = sdk.createToken('USDC', tokensFile.USDC)

  const callback = function (args) {
    console.log(args)
  }

  const executor =
    await builder.startBatch(10)
      .addVoucherRequest({ tokens: [{ token: usdc, amount: 90 }], destinationChainId: 42161, ref: 'voucher1' })
      .endBatch()
      .startBatch(42161)
      .useVoucher('voucher1')
      .addAction(new ApproveAction({ token: usdc, amount: 90 }))
      .addAction(new FunctionCallAction({ functionName: 'purchaseNft', args: [123] }))
      .endBatch()
      .buildAndSign()
      .execute(callback)

```

