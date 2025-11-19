import { Address, Chain, getContract, GetContractReturnType, PublicClient, Transport } from 'viem'

import XlpSelectionHelperMeta
  from '@eil-protocol/contracts/artifacts/src/common/utils/XlpSelectionHelper.sol/XlpSelectionHelper.json' with { type: 'json' }
import { Asset } from '../contractTypes/Asset.js'
import { XlpEntry } from '../contractTypes/XlpEntry.js'
import { getCreate2DeployAddress } from '../deployments/create2deploy.js'
import { amountOrMinAmount, MultiChainAsset, MultichainContract, toAddress } from '../sdk/index.js'

type XlpSelectionHelperContract = GetContractReturnType<typeof XlpSelectionHelperMeta.abi, PublicClient<Transport, Chain>>

export type SolventXlpInfo = {
  xlpEntry: XlpEntry
  deposits: bigint[]
  balances: bigint[]
}

export class SolventXlpSorter {
  constructor (
    readonly arr: SolventXlpInfo[],
    readonly tokens: MultiChainAsset[],
    readonly factor: number
  ) {
  }

  // high priority: deposits ≥ factor × requested amount
  // medium: deposits ≥ requested amount
  // low: requires wallet balance top-up
  _sortPriority (info: SolventXlpInfo): number {
    const { tokens, factor } = this
    let priority: number = 2
    for (let i: number = 0; i < tokens.length; i++) {
      const requestAmount: bigint = amountOrMinAmount(tokens[i])
      if (info.deposits[i] < _factorAmount(factor, requestAmount)) {
        priority = 1
        if (info.deposits[i] < requestAmount) {
          priority = 0
          break
        }
      }
    }
    return priority
  }

  sort (): SolventXlpInfo[] {
    return this.arr.sort((a: SolventXlpInfo, b: SolventXlpInfo) => this._sortPriority(b) - this._sortPriority(a))
  }
}

// Simple factor multiplication; assumes request amounts stay within safe Number range in tests
export function _factorAmount (factor: number, amount: bigint): bigint {
  return BigInt(Math.ceil(Number(amount) * factor))
}

export async function getSolventXlps (
  chainId: bigint,
  paymasters: MultichainContract,
  mcAssets: MultiChainAsset[],
  includeBalance: boolean = true,
  offset: number = 0,
  length: number = 1000
): Promise<SolventXlpInfo[]> {
  const paymasterAddress: Address = paymasters.addressOn(chainId)
  const client: PublicClient = paymasters.client.clientOn(chainId)
  const assets: Asset[] = mcAssets.map((asset: MultiChainAsset) => ({
    erc20Token: toAddress(chainId, asset.token),
    amount: amountOrMinAmount(asset)
  }))

  const helper: XlpSelectionHelperContract = getXlpSelectionContract(client)
  const code: `0x${string}` | undefined = await client.getCode({ address: helper.address })
  if (code == null || code === '0x') {
    throw new Error(`XlpSelectionHelper not deployed on chain ${chainId} at address ${helper.address}`)
  }

  const result: SolventXlpInfo[] = await helper.read.getSolventXlps([paymasterAddress, offset, length, assets, includeBalance]) as SolventXlpInfo[]
  return result
}

export function getXlpSelectionContract (client: PublicClient): XlpSelectionHelperContract {
  return getContract({
    client,
    address: getXlpSelectionHelperAddress(),
    abi: XlpSelectionHelperMeta.abi
  })
}

export function getXlpSelectionHelperAddress (): Address {
  return getCreate2DeployAddress(XlpSelectionHelperMeta)
}
