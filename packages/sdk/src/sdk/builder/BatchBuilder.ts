import { Address, Hex, hexToBigInt, PrivateKeyAccount, publicActions } from 'viem'
import { BaseAction, FunctionCallAction, prepareCallWithRuntimeVars, VoucherRequestAction } from '../actions/index.js'
import { CrossChainBuilder } from './CrossChainBuilder.js'
import { CrossChainVoucherCoordinator } from './CrossChainVoucherCoordinator.js'
import { NetworkEnvironment } from './NetworkEnvironment.js'
import {
  ICrossChainBuilder,
  InternalVoucherInfo,
  isCall,
  isValidAddress,
  MultiChainAsset,
  SdkVoucherRequest,
  SingleChainBatch,
  toAddress,
  UserOperation
} from '../types/index.js'
import { appendPaymasterSignature, getUserOpHash } from '../index.js'
import { assert } from '../sdkUtils/SdkUtils.js'
import { Asset } from '../../contractTypes/Asset.js'
import { abiEncodePaymasterData, nowSeconds } from '../../utils/index.js'

/**
 * Return the minimum amount for an asset.
 * If the amount value is fixed, return it as-is.
 * If the value is dynamic (determined on-chain), return the {@link minProviderDeposit} instead.
 * If {@link minProviderDeposit} is not defined, returns `1`.
 */
export function amountOrMinAmount (asset: MultiChainAsset): bigint {
  if (typeof asset.amount === 'bigint') {
    return asset.amount
  }
  if (asset.minProviderDeposit == undefined) {
    return 1n // real minimum unknown. just verify a non-zero value.
  }
  return asset.minProviderDeposit
}

/**
 * BatchBuilder class - manages single chain operations within a {@link CrossChainBuilder}.
 * Contains all the actions to be executed on a specific chain by the Smart Account.
 * Handles the cross-chain token transfers via {@link SdkVoucherRequest}.
 */
export class BatchBuilder {
  private isBuilt = false

  /** List of input voucher requests to collect before executing all actions */
  private readonly inputVoucherRequests: SdkVoucherRequest[] = []

  /** List of source actions in this UserOperation */
  private readonly actions: BaseAction[] = []

  /** Override fields when building this UserOperation (e.g., specific paymaster or gas values) */
  private userOpOverrides?: Partial<UserOperation>

  /** Names of all dynamic runtime variables used in this batch */
  private _vars: Set<string> = new Set()

  constructor (
    private readonly parentBuilder: ICrossChainBuilder,
    private readonly ephemeralSigner: PrivateKeyAccount,
    private readonly coordinator: CrossChainVoucherCoordinator,
    readonly config: NetworkEnvironment,
    readonly paymaster: `0x${string}`,
    readonly chainId: bigint
  ) {}

  endBatch (): ICrossChainBuilder {
    return this.parentBuilder
  }

  /**
   * Add a new dynamic runtime variable to the batch.
   * Variables can be used to store values that are not known at the time of batch creation.
   * Their actual values are determined on-chain at runtime.
   * For example, one action may need to operate on an outcome of an on-chain swap done as part of a single batch.
   * @param varName The name of the variable to be added to the batch.
   */
  addVar (varName: string) {
    this._vars.add(varName)
  }

  /**
   * Check if the batch contains a specific runtime variable.
   */
  hasVar (varName: string): boolean {
    return this._vars.has(varName)
  }

  /**
   * Adds an action to the current batch. Actions are grouped by chainId.
   * Special actions (voucherRequest, useVoucherRequest) are used to manage flow between chains.
   * @param action The action to be added to the current batch
   * @returns this BatchBuilder instance for chaining
   */
  addAction (action: BaseAction): this {
    this.assertNotBuilt()
    if (action instanceof VoucherRequestAction) {
      this.processVoucherRequest(action.voucherRequest)
    }
    if (action instanceof FunctionCallAction) {
      if (!isValidAddress(this.chainId, action.call.target)) {
        throw new Error(`Calling "${action.call.functionName}" on contract with no address on chain ${this.chainId}`)
      }
    }
    this.actions.push(action)
    return this
  }

  /**
   * Overrides values in the generated UserOperation.
   * Use with caution as incorrect modifications may break the batch functionality.
   * @param overrides a partial {@link UserOperation} object containing fields to override.
   * @returns this {@link BatchBuilder} instance for chaining.
   */
  overrideUserOp (overrides: Partial<UserOperation>): this {
    this.assertNotBuilt()
    // should not override paymaster if the batch has inputs (depends on other batches)
    if (this.inputVoucherRequests.length > 0 && (overrides.paymaster || overrides.paymasterData)) {
      throw new Error(`Cannot override paymaster or paymasterData in a batch`)
    }
    this.userOpOverrides = overrides
    return this
  }

  private processVoucherRequest (req: SdkVoucherRequest) {
    if (req.destinationChainId == this.chainId) {
      throw new Error(`destinationChainId must be different than current chainId ${this.chainId}`)
    }
    if (req.sourceChainId == undefined) {
      req.sourceChainId = this.chainId
    } else {
      assert(req.sourceChainId == this.chainId, `Voucher request sourceChainId ${req.sourceChainId} does not match batch chainId ${this.chainId}`)
    }
    assert(!this.coordinator.has(req), `Voucher request ${req.ref} already exists in this BatchBuilder`)

    req.tokens.forEach(token => {
      if (!isValidAddress(req.sourceChainId!, token.token)) {
        throw new Error(`Voucher token does not have address on chain ${req.sourceChainId}`)
      }
      if (!isValidAddress(req.destinationChainId, token.token)) {
        throw new Error(`Voucher token does not have address on chain ${req.destinationChainId}`)
      }
    })

    this.coordinator.set({
      voucher: req,
      sourceBatch: this,
    })
  }

  /**
   * Add voucher creation to this batch.
   * This will trigger a transfer of the specified tokens to the destination chain.
   */
  addVoucherRequest (req: SdkVoucherRequest): this {
    return this.addAction(new VoucherRequestAction(req))
  }

  /**
   * Use the {@link SdkVoucherRequest} created in an earlier batch to move tokens to this chain.
   */
  useVoucher (refId: string): this {
    this.assertNotBuilt()
    const internalVoucherInfo = this.coordinator.getVoucherInternalInfo(refId)
    const voucher = internalVoucherInfo?.voucher!
    assert(internalVoucherInfo != null, `Voucher request ${refId} not found in action builder`)
    assert(this.userOpOverrides?.paymaster == null && this.userOpOverrides?.paymasterData == null,
      `Cannot override paymaster or paymasterData in a batch that uses vouchers.`)
    assert(internalVoucherInfo.destBatch == undefined, `Voucher request ${refId} already used`)
    assert(voucher.destinationChainId == this.chainId,
      `Voucher request is for chain ${voucher.destinationChainId}, but batch is for chain ${this.chainId}`)
    internalVoucherInfo.destBatch = this
    this.inputVoucherRequests.push(voucher)
    return this
  }

  /**
   * Use all voucher requests for this chain from all previous batches.
   * Throws if no voucher requests were added with the current chain as the destination.
   */
  useAllVouchers (): this {
    let added = false
    const allVoucherRequests = this.coordinator.getAllOutVoucherRequests()
    for (const v of allVoucherRequests) {
      if (v.destinationChainId === this.chainId) {
        added = true
        this.useVoucher(v.ref)
      }
    }
    assert(added, `No voucher requests found for chain ${this.chainId}`)
    return this
  }

  /**
   * Create a {@link UserOperation} with the provided {@link SingleChainBatch} calls and {@link SdkVoucherRequest} list.
   * Notice that all Voucher Requests are appended to the end of the batch regardless of the order they were provided.
   * @returns - a {@link Partial} of the {@link UserOperation}.
   */
  async createUserOp (): Promise<UserOperation> {
    const chainId = this.chainId

    const mcAccount = this.parentBuilder.getAccount()
    const smartAccount = mcAccount.contractOn(chainId)
    const allCalls = await Promise.all(this.actions.map((action) => {
      return action.encodeCall(this)
    }))
    const calls = allCalls.flat().map(call => {
      if (isCall(call)) {
        return call
      } else {
        return prepareCallWithRuntimeVars(call, this)
      }
    })
    const [sender, nonce, { factory, factoryData }, callData] = await Promise.all([
      smartAccount.getAddress(),
      smartAccount.getNonce(),
      smartAccount.getFactoryArgs(),
      calls.length == 0 ? '0x' : mcAccount.encodeCalls(chainId, calls)
    ])

    const nonce1 = BigInt(nowSeconds()) << 64n
    const { maxFeePerGas, maxPriorityFeePerGas } = await smartAccount.client.extend(publicActions).estimateFeesPerGas()
    let userOp = {
      chainId,
      sender,
      nonce: nonce1,
      factory,
      factoryData,
      callData,
      callGasLimit: 3000000n,
      verificationGasLimit: 500000n,
      preVerificationGas: 100000n,
      maxFeePerGas,
      maxPriorityFeePerGas,
      ...this.userOpOverrides as any
    }

    const {
      paymaster,
      paymasterData,
      paymasterVerificationGasLimit,
      paymasterPostOpGasLimit
    } = await this.createPaymasterInfo(userOp, this.inputVoucherRequests)

    if (paymaster != null) {
      userOp = {
        ...userOp,
        paymaster,
        paymasterData,
        paymasterVerificationGasLimit,
        paymasterPostOpGasLimit
      }
    }

    return userOp
  }

  private async createPaymasterInfo (
    userOp: Partial<UserOperation>,
    voucherRequests: SdkVoucherRequest[]):
    Promise<{
      paymaster?: Address;
      paymasterData?: Hex;
      paymasterVerificationGasLimit?: bigint;
      paymasterPostOpGasLimit?: bigint
    }> {

    if (voucherRequests.length === 0) {
      if (this.config.input.sourcePaymaster != null) {
        // use source paymaster
        return this.config.input.sourcePaymaster.getPaymasterStubData(userOp as any)
      } else {
        // no paymaster. account pays with eth.
        return {}
      }
    }

    return {
      paymaster: this.paymaster,
      paymasterData: this._createPaymasterData(voucherRequests),
      paymasterVerificationGasLimit: 500000n, //todo: estimate gas
      paymasterPostOpGasLimit: 100000n
    }
  }

  _createPaymasterData (voucherRequests: SdkVoucherRequest[]): Hex {
    if (voucherRequests.length === 0) {
      // no voucher requests meaning no paymaster data for the AtomicSwapPaymaster
      return '0x'
    }

    // encode the voucher requests into the paymaster data
    const basePaymasterData = abiEncodePaymasterData({
      vouchersAssetsMinimums: voucherRequests.map(
        this._toVouchersAssetsMinimums.bind(this)),
      ephemeralSigner: this.ephemeralSigner.address
    })
    return appendPaymasterSignature(basePaymasterData, '0x01')
  }

  _toVouchersAssetsMinimums (action: SdkVoucherRequest): Asset[] {
    const chainId = action.destinationChainId
    return action.tokens.map(asset => ({
      erc20Token: toAddress(chainId, asset.token),
      amount: amountOrMinAmount(asset)
    }))
  }

  async buildSingleChainBatch (): Promise<SingleChainBatch> {
    const userOp = await this.createUserOp()
    const userOpHash = getUserOpHash(userOp)
    return {
      userOp,
      userOpHash,
      chainId: this.chainId,
      inputVoucherRequests: this.inputVoucherRequests,
      outVoucherRequests: this.getOutVoucherRequests(),
    }
  }

  getVoucherInternalInfo (voucher: SdkVoucherRequest): InternalVoucherInfo | undefined {
    return this.coordinator.getVoucherInternalInfo(voucher.ref)
  }

  getOutVoucherRequests (): SdkVoucherRequest[] {
    return this.actions
      .filter(action => action instanceof VoucherRequestAction)
      .map(action => action.voucherRequest)
  }

  private assertNotBuilt () {
    if (this.isBuilt) {
      throw new Error('CrossChainBuilder already built. Create a new instance to build a new session.')
    }
  }
}
