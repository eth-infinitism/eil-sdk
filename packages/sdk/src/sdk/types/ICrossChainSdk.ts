import { ICrossChainBuilder } from './ICrossChainBuilder.js'
import { AddressPerChain } from './MultichainContract.js'
import { MultichainToken } from './MultichainToken.js'
import { NetworkEnvironment } from '../builder/index.js'

/**
 * CrossChainSdk is the main entry point for building cross-chain actions.
 * holds the configuration, and used to create the BatchBuilder
 */
export interface ICrossChainSdk {

  /**
   * create a builder for a cross-chain operation
   */
  createBuilder (): ICrossChainBuilder

  /**
   * create a MultichainToken with the given deployment addresses
   */
  createToken (name: string, deployments: AddressPerChain): MultichainToken

  getNetworkEnv(): NetworkEnvironment
}

