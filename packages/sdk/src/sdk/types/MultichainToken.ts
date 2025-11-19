import { AddressPerChain, MultichainContract } from './MultichainContract.js'
import { Address, erc20Abi, PublicClient } from 'viem'

import { MultichainClient } from './MultichainClient.js'
import { IMultiChainEntity, toAddress } from './index.js'

export type TotalBalanceOfResult = {
  perChainBalance: Array<{ chainId: bigint, balance: bigint }>
  totalBalance: bigint;
}

//wrapper for multichain ERC20 token operations.
export class MultichainToken extends MultichainContract {
  constructor (name: string, client: MultichainClient, deployments: AddressPerChain) {
    super(client, erc20Abi, deployments)
  }

  async balanceOf (chainId: bigint, address: Address | IMultiChainEntity): Promise<bigint> {
    return this.call(chainId, 'balanceOf', [toAddress(chainId, address)])
  }

  async symbol (chainId: bigint): Promise<string> {
    return this.call(chainId, 'symbol', [])
  }

  async decimals (chainId: bigint): Promise<number> {
    return this.call(chainId, 'decimals', [])
  }

  async allowance (chainId: bigint, owner: IMultiChainEntity, spender: IMultiChainEntity): Promise<bigint> {
    return this.call(chainId, 'allowance', [toAddress(chainId, owner), toAddress(chainId, spender)])
  }

  async totalBalanceOf (targetAddress: Address | IMultiChainEntity): Promise<TotalBalanceOfResult> {
    const balances = await Promise.all(this.client.all().map((client: PublicClient) => {
      const chainId = BigInt(client.chain!.id)
      return this.balanceOf(chainId, targetAddress)
    }))

    const totalBalance = balances.reduce((acc, balance) => acc + balance)
    const perChainBalance = this.client.all().map((client: PublicClient, index: number) => {
      return { chainId: BigInt(client.chain!.id), balance: balances[index] }
    })
    return {
      perChainBalance,
      totalBalance
    }
  }
}
