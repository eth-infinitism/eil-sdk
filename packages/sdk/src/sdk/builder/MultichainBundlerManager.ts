import { Address, createClient, fromHex, Hex, http } from 'viem'

import { stringifyBigIntReplacer } from '../sdkUtils/SdkUtils.js'
import { IBundlerManager } from '../types/IBundlerManager.js'
import { ChainInfo } from '../config/index.js'
import { UserOperation } from '../types/UserOperation.js'
import { IJsonRpcProvider } from '../types/index.js'

export class MultichainBundlerManager implements IBundlerManager {

  constructor (readonly chainInfos: ChainInfo[]) {
    for (const { chainId, bundlerUrl, entryPointAddress } of chainInfos) {
      let provider = createClient({
        transport: http(bundlerUrl, { retryCount: 0 })
      }).transport
      if (bundlerUrl !== undefined) {
        this.addBundler(chainId, provider, entryPointAddress!)
      }
    }
  }

  bundlers: Map<bigint, IJsonRpcProvider> = new Map()
  entryPoints: Map<bigint, Address> = new Map()

  addBundler (chainId: bigint, provider: IJsonRpcProvider, entryPointAddress: Address) {
    this.bundlers.set(chainId, provider)
    this.entryPoints.set(chainId, entryPointAddress)
  }

  async verifyConfig (chainId: bigint, entryPoint: Address): Promise<void> {
    const bundler = this.bundlers.get(chainId)
    if (bundler == null) {
      throw new Error(`No bundler configured for chain ${chainId}`)
    }
    const bundlerChainId = fromHex(await bundler.request({ 'method': 'eth_chainId' }), 'bigint')
    if (bundlerChainId != chainId) {
      throw new Error(`Bundler for chain ${chainId} is configured with a wrong chainId ${bundlerChainId}`)
    }
    const supportedEntryPoints = await bundler.request({ 'method': 'eth_supportedEntryPoints' }) as Address[]
    if (!supportedEntryPoints.map(addr => addr.toLowerCase()).includes(entryPoint.toLowerCase())) {
      throw new Error(`Bundler for chain ${chainId} does not support EntryPoint at address ${entryPoint}, only ${supportedEntryPoints}`)
    }
  }

  sendUserOperation (userOp: UserOperation): Promise<Hex> {
    const provider = this.bundlers.get(userOp.chainId!)!
    if (!provider) {
      throw new Error(`No bundler found for chainId: ${userOp.chainId!}`)
    }
    const jsonUserOp = JSON.parse(JSON.stringify(userOp, stringifyBigIntReplacer))
    return provider.request({
      method: 'eth_sendUserOperation',
      params: [jsonUserOp, userOp.entryPointAddress]
    })
  }
}
