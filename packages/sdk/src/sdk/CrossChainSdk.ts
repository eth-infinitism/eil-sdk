import { CrossChainConfig, defaultCrossChainConfig } from './config/index.js'
import { AddressPerChain, ICrossChainBuilder, ICrossChainSdk, MultichainToken } from './types/index.js'
import { CrossChainBuilder, NetworkEnvironment } from './builder/index.js'

/**
 * This class is the main component for building cross-chain actions.
 * It holds the configuration and is used to create the {@link BatchBuilder}.
 */
export class CrossChainSdk implements ICrossChainSdk {

  networkEnv: NetworkEnvironment

  constructor (
    config: CrossChainConfig = defaultCrossChainConfig
  ) {
    this.networkEnv = new NetworkEnvironment(config)
  }

  /**
   * create a builder for a cross-chain operation
   */
  createBuilder (): ICrossChainBuilder {
    return new CrossChainBuilder(this.networkEnv)
  }

  /**
   * create a MultichainToken with the given deployment addresses
   */
  createToken (name: string, deployments: AddressPerChain): MultichainToken {
    return new MultichainToken(name, this.networkEnv.chains, deployments)
  }

  getNetworkEnv (): NetworkEnvironment {
    return this.networkEnv
  }
}

