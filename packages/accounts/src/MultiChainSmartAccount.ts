import { SmartAccount } from 'viem/account-abstraction'
import { Call, Hex, LocalAccount, } from 'viem'
import {
  asCall,
  BaseMultichainSmartAccount,
  FunctionCall,
  ICrossChainSdk,
  MultichainBundlerManager,
  UserOperation
} from '@eil-protocol/sdk'
import { toSimpleSmartAccount } from 'permissionless/accounts'

/**
 * a simple MultichainAccount. using SimpleSmartAccount on each chain.
 * Note that the signature method called for each SimpleSmartAccount instead separately.
 * Also, its encoding can't support dynamic calls.
 */
export class MultiChainSmartAccount extends BaseMultichainSmartAccount {

  accounts: Map<bigint, SmartAccount> = new Map()

  /**
   * Creates a new MultiChainSmartAccount instance
   * @param owner - The account owner used for multichain signing. Must belong to the same owner across all chains.
   * @param sdk - the sdk configuration to read supported network
   * @param accounts - Array of {@link SmartAccount} instances for different chains (optional).
   * @notice The owner must have signing capabilities for all chains.
   * @dev Note that SimpleAccount API doesn't expose the owner directly.
   */
  protected constructor (
    readonly owner: LocalAccount,
    sdk: ICrossChainSdk,
    accounts: SmartAccount[]
  ) {

    const bundlerManager = new MultichainBundlerManager(sdk.getNetworkEnv().input.chainInfos)
    super(bundlerManager)
    this.addAccounts(accounts)
  }

  static async create (
    owner: LocalAccount,
    sdk: ICrossChainSdk,
    accounts?: SmartAccount[]
  ): Promise<MultiChainSmartAccount> {
    const networkEnv = sdk.getNetworkEnv()
    if (accounts == null) {
      accounts = []
      for (const chain of networkEnv.input.chainInfos) {
        let client = networkEnv.chains.clientOn(chain.chainId)
        const entryPointAddress = networkEnv.entrypoints.addressOn(chain.chainId)

        const factoryAddress = '0x2862B77afcF4405e766328E697E0236b9974b8fa' //ep9 simpleAccount factory
        const account: SmartAccount = await toSimpleSmartAccount({
          owner,
          client,
          entryPoint: {
            address: entryPointAddress,
            version: '0.8'
          },
          factoryAddress
        })
        accounts.push(account)
      }
    }
    return new MultiChainSmartAccount(
      owner,
      sdk,
      accounts
    )
  }

  //add chain-specific instances of the account.
  //TODO: currently needs viem "SmartAccount" for each chain. better unify it
  // (some methods are chain-specific, like "getNonce". others (like encode) are not.
  protected addAccounts (accounts: SmartAccount[]) {
    for (const account of accounts) {
      const chainId = BigInt(account.client.chain?.id!)
      if (this.accounts.has(chainId)) {
        throw new Error(`Account object already exists for chainId: ${chainId}`)
      }
      this.accounts.set(chainId, account)
    }
  }

  hasAddress (chainId: bigint): boolean {
    return this.accounts.has(chainId)
  }

  contractOn (chainId: bigint): SmartAccount {
    if (!this.accounts.has(chainId)) {
      throw new Error(`No account found for chainId: ${chainId}`)
    }
    return this.accounts.get(chainId)!
  }

  async signUserOps (userOps: UserOperation[]): Promise<UserOperation[]> {
    // naive implementation: sign using each per-chain account.
    const result: UserOperation[] = []
    for (const userOp of userOps) {
      const chainId = userOp.chainId
      if (chainId == null) {
        throw new Error(`signUserOps: can only sign userOps with chain`)
      }
      const account = this.contractOn(chainId)
      const signature = await account.signUserOperation(userOp as any)
      result.push({ ...userOp, signature })
    }
    return result
  }

  async encodeCalls (chainId: bigint, calls: Array<Call | FunctionCall>): Promise<Hex> {
    const plainCalls: Call[] = calls.map(call => asCall(chainId, call))
    return this.contractOn(chainId).encodeCalls(plainCalls)
  }
}

