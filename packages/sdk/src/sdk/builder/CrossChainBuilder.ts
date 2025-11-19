import type { Abi } from 'viem'
import {
  Address,
  Hex,
  hexToBigInt,
  keccak256,
  PrivateKeyAccount,
  publicActions,
  PublicClient,
  stringToBytes
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import IEntryPointInterface from '@account-abstraction/contracts/artifacts/IEntryPoint.json' with { type: 'json' }

import { AtomicSwapFeeRule } from '../../contractTypes/AtomicSwapFeeRule.js'
import { amountOrMinAmount, BatchBuilder } from './BatchBuilder.js'
import { CrossChainExecutor } from './CrossChainExecutor.js'
import { NetworkEnvironment } from './NetworkEnvironment.js'
import {
  ICrossChainBuilder,
  InternalVoucherInfo,
  MultichainContract,
  MultichainToken,
  SdkVoucherRequest,
  SingleChainBatch,
  toAddress,
  UserOperation
} from '../types/index.js'
import { VoucherRequest } from '../../contractTypes/VoucherRequest.js'
import { nowSeconds } from '../../utils/utils.js'
import { CrossChainVoucherCoordinator } from './CrossChainVoucherCoordinator.js'
import { IMultiChainSmartAccount } from '../account/index.js'
import { _factorAmount, getSolventXlps, SolventXlpInfo, SolventXlpSorter } from '../../utils/getSolventXlps.js'
import { defaultFeeConfig, defaultXlpSelectionConfig, FeeConfig, XlpSelectionConfig } from '../config/index.js'

/**
 * Maximum number of XLPs to allow for a voucher.
 * We limit this to avoid excessive gas costs when creating the voucher request.
 */
const I_ENTRY_POINT_ID = computeInterfaceId(IEntryPointInterface.abi as Abi)

/**
 * A Builder for a cross-chain session.
 * The session is built from multiple batches, each batch running on a specific chain.
 * Each batch can contain multiple actions and can create "Voucher Requests" to move tokens to other chains.
 * These tokens can later be used in batches on those destination chains via the 'useVoucher' function.
 */
export class CrossChainBuilder implements ICrossChainBuilder {

  private readonly ephemeralSigner: PrivateKeyAccount
  private readonly coordinator: CrossChainVoucherCoordinator
  readonly xlpSelectionConfig: XlpSelectionConfig
  readonly feeConfig: FeeConfig
  private isBuilt = false
  private initialized = false

  batchBuilders: BatchBuilder[] = []
  smartAccount: IMultiChainSmartAccount | undefined

  constructor (
    readonly config: NetworkEnvironment,
  ) {
    this.ephemeralSigner = privateKeyToAccount(generatePrivateKey())
    this.coordinator = new CrossChainVoucherCoordinator()
    this.xlpSelectionConfig = { ...defaultXlpSelectionConfig, ...config.input.xlpSelectionConfig ?? {} }
    this.feeConfig = { ...defaultFeeConfig, ...config.input.feeConfig ?? {} }
  }

  useAccount (account: IMultiChainSmartAccount): this {
    if (this.smartAccount != null) {
      throw new Error('cannoot call useAccount() more than once')
    }
    this.smartAccount = account
    return this
  }

  getAccount (): IMultiChainSmartAccount {
    if (this.smartAccount == null) {
      throw new Error('must call useAccount() before build')
    }
    return this.smartAccount
  }

  /**
   * create a new batch, to be executed on the given chain.
   * @param chainId the chain this batch will be executed on.
   */
  startBatch (chainId: bigint): BatchBuilder {
    this.assertNotBuilt()
    const batch = new BatchBuilder(
      this,
      this.ephemeralSigner,
      this.coordinator,
      this.config,
      this.config.paymasters.addressOn(chainId),
      chainId
    )
    this.batchBuilders.push(batch)
    return batch
  }

  /**
   * Scan all Vouchers Requests and make sure they are all consumed by another batch.
   * Create actual voucher objects and request IDs.
   */
  private async buildVouchers () {
    //make sure all voucher requests are consumed

    const internalInfos = this.coordinator.getAllVoucherInternalInfos()
    await Promise.all(internalInfos.map(async (info: InternalVoucherInfo) => {
        if (info.destBatch == null) {
          throw new Error(`Voucher request ${info.voucher} created on chain ${info.sourceBatch.chainId} not used in any other batch`)
        }
        info.voucherRequest = await this.sdkToVoucherRequest(info.voucher)
      })
    )
  }

  //scan all voucher requests, and collect providers for each.
  // early abort if any of the chains ismissing
  // note that if any voucher request uses runtime vars, we cannot determine the required balance.
  // in this case, assume a minimum value.
  private async collectXlpsPerVoucher () {
    await Promise.all(
      this.batchBuilders.flatMap(builder =>
        builder.getOutVoucherRequests().map(async voucherReq => {
          await this.updateVoucherXlps(voucherReq, await this.getAllowedXlps(voucherReq))
        })
      )
    )
  }

  async buildSingleChainBatches (): Promise<SingleChainBatch[]> {
    this.assertNotBuilt()
    await this.initialize()

    await this.collectXlpsPerVoucher()

    //todo: need to validate the graph is acyclic
    await this.buildVouchers()
    let allBatches: SingleChainBatch[] = []
    for (const batchBuilder of this.batchBuilders) {
      const singleChainBatch = await batchBuilder.buildSingleChainBatch()
      allBatches.push(singleChainBatch)
    }
    return allBatches
  }

  /**
   * Build an array of {@link SingleChainBatch} objects and create a {@link CrossChainExecutor} to execute them.
   * The smartAccount of this builder is used to sign the UserOps, by calling its signUserOps() method.
   */
  async buildAndSign (): Promise<CrossChainExecutor> {

    const batches = await this.buildSingleChainBatches()
    const userOpsToSign = batches.map(batch => {
      return {
        ...batch.userOp,
        chainId: batch.chainId,
        entryPointAddress: this.config.entrypoints.addressOn(batch.chainId)
      }
    })
    let smartAccount = this.getAccount()
    for (const userOp of userOpsToSign) {

      await smartAccount.verifyBundlerConfig(userOp.chainId!, userOp.entryPointAddress!)
    }
    const signedUserOps = await smartAccount.signUserOps(userOpsToSign)

    //update the signed users in the batches
    batches.forEach((batch, index) => {
      batch.userOp = signedUserOps[index]
    })
    //once we create an executor, the builder is considered "built", so it can't be reused.
    this.isBuilt = true
    return new CrossChainExecutor(this, this.config, this.ephemeralSigner, batches)
  }

  /**
   * Build an array of {@link SingleChainBatch} objects, ready to be signed
   */
  async getUserOpsToSign (): Promise<UserOperation[]> {
    const batches = await this.buildSingleChainBatches()
    const userOps: UserOperation[] = batches.map(batch => batch.userOp as UserOperation)
    return userOps
  }

  // check that configuration is valid: that configured with proper paymasters and entrypoints
  async initialize () {
    if (this.initialized) {
      //need to assert contracts only once.
      return
    }
    await Promise.all(this.config.chains.all().map(async (client: PublicClient) => {
      await this.checkChainConfiguration(client)
    }))
    this.initialized = true
  }

  //check configuration for the given chain.
  async checkChainConfiguration (client: PublicClient) {
    const chainId = BigInt(await client.extend(publicActions).getChainId())
    const { entrypoints, paymasters } = this.config
    await this.ensureEntryPointInterfaceSupport(chainId, entrypoints, client)

    let sessionData = { data: '0x', ephemeralSignature: '0x' }
    await this.checkContract('CrossChainPaymaster', client, paymasters, 'getHashForEphemeralSignature', [[], sessionData])
  }

  //validate a configuration, by checking a contract supports the correct interface.
  async checkContract (name: string, client: PublicClient, contract: MultichainContract, functionName: string, args: any[], expectedRet?: any): Promise<void> {
    const chainId = BigInt(await client.getChainId())
    const address = contract.addressOn(chainId)
    const code = await client.getCode({ address })
    if (code == null) {
      throw new Error(`Contract ${name} not deployed on chain ${chainId} at address ${address}`)
    }
    let ret: any
    try {
      ret = await contract.call(chainId, functionName, args)
    } catch (e) {
      throw new Error(`Contract ${name} on chain ${chainId} at address ${address} not supported: ${functionName} reverted with ${e}`)
    }
    if (expectedRet != null && ret != expectedRet) {
      //either we don't care about return value, or it matches expected
      throw new Error(`Contract ${name} on chain ${chainId} at address ${address} not supported: ${functionName} returned ${ret} instead of expected ${expectedRet}`)
    }
    //failure is either revert, or wrong return value
  }

  // todo: implement the fee logic throughout the sdk
  _createFeeRules (): AtomicSwapFeeRule {

    const { startFeePercent, maxFeePercent, feeIncreasePerSecond, unspentVoucherFeePercent } = this.feeConfig

    return {
      startFeePercentNumerator: BigInt(startFeePercent * 10_000),
      maxFeePercentNumerator: BigInt(maxFeePercent * 10_000),
      feeIncreasePerSecond: BigInt(feeIncreasePerSecond * 10_000),
      unspentVoucherFee: BigInt(unspentVoucherFeePercent * 10_000),
    }
  }

  /**
   * Call the paymaster's 'getSenderNonce' view function for the account.
   */
  async _getVoucherSenderNonce (chainId: bigint) {
    let smartAccount = this.getAccount()
    return await this.config.paymasters.call(chainId,
      'getSenderNonce', [smartAccount.addressOn(chainId)])
  }

  /**
   * Returns a list of xlps on the destination chain that can fulfill the voucher request.
   * The xlps must:
   * - Hold enough balance to pay for the voucher request
   * - Be staked on mainnet
   * The policy (XlpSelectionPolicy) can be used to filter XLPs,
   * @param voucherRequestAction - The {@link SdkVoucherRequest} to find xlps for.
   * @returns An array of xlps addresses on the destination chain.
   */
  async getAllowedXlps (voucherRequestAction: SdkVoucherRequest): Promise<Address[]> {

    const policy = { ...defaultXlpSelectionConfig, ...this.xlpSelectionConfig }

    const destChain = voucherRequestAction.destinationChainId
    const tokens = voucherRequestAction.tokens

    const {
      depositReserveFactor,
      includeBalance,
      minXlps,
      maxXlps,
      customXlpFilter
    } = policy

    const tokensWithMinAmounts = tokens.map(t => ({
      token: t.token,
      amount: _factorAmount(depositReserveFactor, amountOrMinAmount(t))
    }))
    let xlps: SolventXlpInfo[] = await getSolventXlps(
      destChain,
      this.config.paymasters,
      tokensWithMinAmounts,
      includeBalance
    )
    const filtered: SolventXlpInfo[] = []
    if (customXlpFilter != null) {
      for (const [index, r] of xlps.entries()) {
        if (!await customXlpFilter(destChain, r.xlpEntry.l2XlpAddress, toAddress(destChain, tokens[index].token), r.deposits[0], r.balances[0])) {
          console.debug(`customXlpFilter: filtered out ${r.xlpEntry.l2XlpAddress} on chain ${destChain}`)
          continue
        }
        filtered.push(r)
      }
      console.debug(`customXlpFilter: ${xlps.length} providers, ${xlps.length - filtered.length} filtered out`)
      xlps = filtered
    }

    if (xlps.length < minXlps) {
      if (minXlps === 1) {
        throw new Error(`No xlps found on destination chain ${destChain} with enough balance`)
      } else {
        throw new Error(`Only found ${xlps.length} xlps on destination chain ${destChain} with enough balance. Minimum required is ${minXlps}`)
      }
    }

    xlps = new SolventXlpSorter(xlps, voucherRequestAction.tokens, depositReserveFactor).sort().slice(0, maxXlps)

    return xlps.map(r => r.xlpEntry.l2XlpAddress)
  }

  async updateVoucherXlps (voucherReq: SdkVoucherRequest, xlps: Address[]) {
    this.coordinator.updateVoucherXlps(voucherReq, xlps)
  }

  //helper function: dump the liquidity of all XLPs on a given chain for the given tokens
  async dumpChainXlps (chainId: bigint, tokens: Array<MultichainToken>) {
    console.log(`Dump of xlp liquidity on ${chainId}`)
    const ret = await getSolventXlps(chainId, this.config.paymasters,
      tokens.map(token => ({ token, amount: 0n })))
    for (const info of ret) {
      for (let i = 0; i < tokens.length; i++) {
        console.log(`xlp: ${info.xlpEntry.l2XlpAddress} token: ${toAddress(chainId, tokens[i])} deposit: ${info.deposits[i]} balance: ${info.balances[i]}`)
      }
    }
  }

  getVoucherInternalInfo (voucher: SdkVoucherRequest): InternalVoucherInfo {
    const info = this.coordinator.getVoucherInternalInfo(voucher.ref)
    if (info == null) {
      throw new Error(`Voucher request ${voucher} not found in action builder`)
    }
    return info
  }

  private async sdkToVoucherRequest (voucherRequest: SdkVoucherRequest): Promise<VoucherRequest> {
    let voucherInternalInfo = this.getVoucherInternalInfo(voucherRequest)
    const chainId = voucherInternalInfo.sourceBatch.chainId
    const allowedXlps = voucherInternalInfo.allowedXlps!
    const destChainId = voucherRequest.destinationChainId
    const account = this.getAccount().contractOn(chainId)
    const destAccount = this.getAccount().contractOn(destChainId)
    const paymaster = this.config.paymasters.addressOn(chainId)
    const destPaymaster = this.config.paymasters.addressOn(destChainId)
    return {
      origination: {
        chainId,
        sender: account.address,
        paymaster,
        feeRule: this._createFeeRules(),
        senderNonce: await this._getVoucherSenderNonce(chainId),
        allowedXlps,
        assets: voucherRequest.tokens.map(asset => ({
          erc20Token: toAddress(chainId, asset.token),
          amount: asset.amount as any //amount can be runtimeVar.
        })),
      },
      destination: {
        chainId: destChainId,
        sender: voucherRequest.target ?? destAccount.address,
        paymaster: destPaymaster,
        assets: voucherRequest.tokens.map(asset => ({
          erc20Token: toAddress(destChainId, asset.token),
          amount: asset.amount as any
        })),
        maxUserOpCost: 10_000_000_000_000_000n, //todo: update after estimating userop gas
        expiresAt: BigInt(nowSeconds() + this.config.input.expireTimeSeconds),
      }
    }
  }

  private assertNotBuilt () {
    if (this.isBuilt) {
      throw new Error('CrossChainBuilder already built. Create a new instance to build a new session.')
    }
  }

  private async ensureEntryPointInterfaceSupport (chainId: bigint, entrypoints: MultichainContract, client: PublicClient) {
    const address = entrypoints.addressOn(chainId)
    const code = await client.getCode({ address })
    if (code == null || code === '0x') {
      throw new Error(`Contract EntryPoint not deployed on chain ${chainId} at address ${address}`)
    }

    try {
      await entrypoints.call(chainId, 'supportsInterface', [toInterfaceHex(I_ENTRY_POINT_ID)])
    } catch (e) {
      throw new Error(`Contract EntryPoint on chain ${chainId} at address ${address} not supported: supportsInterface reverted with ${e}`)
    }
  }
}

function computeInterfaceId (abi: Abi): bigint {
  let id = 0n
  for (const item of abi) {
    if (item.type !== 'function') continue
    const inputs = item.inputs?.map(input => input.type).join(',') ?? ''
    const signature = `${item.name}(${inputs})`
    const hash = keccak256(stringToBytes(signature))
    const selector = hexToBigInt(('0x' + hash.slice(2, 10)) as Hex)
    id ^= selector
  }
  return id
}

function toInterfaceHex (id: bigint): Hex {
  return (`0x${id.toString(16).padStart(8, '0')}`) as Hex
}
