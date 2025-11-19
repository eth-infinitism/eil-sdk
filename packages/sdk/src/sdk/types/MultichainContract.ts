//todo: make this type-safe, using TAbi...
import { Abi, Address, decodeFunctionResult, encodeFunctionData, Hex, isHex } from 'viem'

import { MultichainClient } from './MultichainClient.js'
import { IMultiChainEntity } from './IMultiChainEntity.js'

export type AddressPerChain =
  | Address
  | Array<{ chainId: string | number | bigint, address: string }>
  | Array<[bigint | number | string, Address]>

export class MultichainContract implements IMultiChainEntity {
  deployments: Map<bigint, Address> = new Map()
  readonly defaultAddr?: Address

  static isMultichainContract (obj: any): obj is MultichainContract {
    return typeof obj.addressOn == 'function'
  }

  constructor (
    readonly client: MultichainClient,
    readonly abi: Abi | readonly unknown[],
    deployments: AddressPerChain = []) {

    if (!Array.isArray(deployments)) {
      if (!isHex(deployments)) {
        throw new Error(`deployment address is either array or specific address`)
      }
      this.defaultAddr = deployments as Address
    } else {
      for (const entry of deployments) {
        if (Array.isArray(entry)) {
          const [chainId, address] = entry
          this.addAddress(BigInt(chainId), address as Address)
        } else {
          const { chainId, address } = entry
          this.addAddress(BigInt(chainId), address as Address)
        }
      }
    }
  }

  addAddress (chainId: bigint, address: Address): void {
    if (this.deployments.has(chainId)) {
      throw new Error(`Address already exists for chainId: ${chainId}`)
    }
    this.deployments.set(chainId, address)
  }

  hasAddress (chainId: bigint): boolean {
    return this.deployments.has(chainId)
  }

  addressOn (chainId: bigint): Address {
    if (!this.deployments.has(chainId) && !this.defaultAddr) {
      throw new Error(`MultiChainEntity does not have an address on chain ${chainId}`)
    }
    return (this.deployments.get(chainId) ?? this.defaultAddr!) as any
  }

  encodeFunctionData (functionName: string, args: any[]): Hex {
    return encodeFunctionData({ abi: this.abi, functionName, args })
  }

  decodeFunctionResult (functionName: string, data: Hex): any {
    return decodeFunctionResult({ abi: this.abi, functionName, data })
  }

  async call (chainId: bigint, functionName: string, args: any[], callOptions: any = {}): Promise<any> {
    const client = this.client.clientOn(chainId)
    const data = this.encodeFunctionData(functionName, args)
    const ret = await client.call({
      to: this.addressOn(chainId),
      data,
      ...callOptions
    })
    return this.decodeFunctionResult(functionName, ret.data!)
  }
}
