//wrapper for PublicClient:
// the network "provider" for all blockchain read operations.
import { Address, decodeFunctionResult, encodeFunctionData, Hex, PublicClient, toHex } from "viem";
import { ChainInfo } from '../config/index.js'

export class MultichainClient {
  clients: Map<bigint, PublicClient> = new Map()

  static create (chains: ChainInfo[]): MultichainClient {
    return new MultichainClient(chains.map(chain=>chain.publicClient))
  }

  constructor (publicClients: PublicClient[] = []) {
    for (const client of publicClients) {
      this.addClientWithChainId(client, BigInt(client.chain!.id))
    }
  }

  //return all clients, to do a "forEach"
  all (): PublicClient[] {
    return Array.from(this.clients.values());
  }

  async addClient (client: PublicClient) {
    const chainId = BigInt(await client.getChainId())
    this.addClientWithChainId(client, chainId)
  }

  addClientWithChainId (client: PublicClient, chainId: bigint,) {
    if (this.clients.has(chainId)) {
      throw new Error(`Client already exists for chainId: ${chainId}`);
    }
    this.clients.set(chainId, client);
  }

  clientOn (chainId: bigint): PublicClient {
    if (!this.clients.has(chainId)) {
      throw new Error(`No client found for chainId: ${chainId}. Supported chains: ${Array.from(this.clients.keys()).join(', ')}`);
    }
    return this.clients.get(chainId)!;
  }

  async call ({ chainId, to, abi, functionName, args, value }: {
    chainId: bigint,
    to: Address,
    abi: readonly unknown[],
    functionName: string,
    args: any[],
    value?: bigint
  }): Promise<any> {
    const client = this.clientOn(chainId);
    const data = encodeFunctionData({ abi, functionName, args });
    const valueHex = value ? toHex(value) : undefined
    const ret = await client.request({ method: 'eth_call', params: [{ to, data, value: valueHex }, 'latest'] }) as Hex
    return decodeFunctionResult({ abi, functionName, data: ret });
  }
}
