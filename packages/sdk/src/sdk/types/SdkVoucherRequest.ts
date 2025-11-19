// generate a lockUserDeposit on current chain, in order to get
// a voucher for destination chain.
//(temp name: avoid conflict from contract-level VoucherRequest)
import { Address } from "viem";
import { MultiChainAsset } from "./MultiChainAsset.js";

export interface SdkVoucherRequest {
  tokens: MultiChainAsset[]
  //target defaults to the current account
  target?: Address
  sourceChainId?: bigint
  destinationChainId: bigint

  // internal ID used during batch building. must be unique.
  ref: string
}
