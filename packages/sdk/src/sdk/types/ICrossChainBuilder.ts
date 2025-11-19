import { BatchBuilder, CrossChainExecutor } from '../builder/index.js'
import { SingleChainBatch } from './SingleChainBatch.js'
import { UserOperation } from './UserOperation.js'
import { IMultiChainSmartAccount } from '../account/index.js'

export interface ICrossChainBuilder {

  /**
   * create a new batch, to be executed on the given chain.
   * @param chainId
   */
  startBatch (chainId: bigint): BatchBuilder;

  /**
   * set the account to use to build and execution that coross chain operation
   * must be called before build() and sign()
   */
  useAccount(account: IMultiChainSmartAccount): this

  /**
   * Build an array of {@link SingleChainBatch} objects, ready to be signed
   * This method first find XLPs on all required chains, and create the UserOps to use them
   * The UserOps can be simulated (they contain dummy "transfers", so the execution on each chain will see the transfered values)
   * This method is called by ${link buildAndSign()}.
   */
  getUserOpsToSign (): Promise<UserOperation[]>;

  /**
   * Build an array of {@link SingleChainBatch} objects and create a {@link CrossChainExecutor} to execute them.
   * The smartAccount of this builder is used to sign the UserOps, by calling its signUserOps() method.
   */
  buildAndSign (): Promise<CrossChainExecutor>;

  getAccount(): IMultiChainSmartAccount

  /**
   * initialize the SDK. validate all configuration is correct.
   */
  initialize (): Promise<void>
}
