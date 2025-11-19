import { Address, Call } from 'viem'

import { BaseAction, BatchBuilder, FunctionCall, SdkVoucherRequest, toAddress } from '../index.js'
import { NATIVE_ETH } from '../types/index.js'

/**
 * The internal class defining an action to lock the user deposit for the specified {@link SdkVoucherRequest}.
 */
export class VoucherRequestAction implements BaseAction {
  private nativeAmount: bigint = 0n

  constructor (
    readonly voucherRequest: SdkVoucherRequest
  ) {
    this.voucherRequest.tokens.forEach((asset, index) => {
      if (asset.token === NATIVE_ETH) {
        if (index !== 0) {
          throw new Error(`Native ETH can only be used as the first asset in a voucher request`)
        }
        if (typeof asset.amount !== 'bigint') {
          throw new Error(`When using a native currency (ETH), the 'amount' parameter must be a fixed bigint value`)
        }
        this.nativeAmount = asset.amount
      }
    })
  }

  async encodeCall (batch: BatchBuilder): Promise<Array<Call | FunctionCall>> {
    const paymasterAddr: Address = batch.config.paymasters.addressOn(batch.chainId)
    //fill in source chainid.
    const voucherRequest = batch.getVoucherInternalInfo(this.voucherRequest)?.voucherRequest
    if (voucherRequest == null) {
      throw new Error(`Voucher request ${this.voucherRequest} not found in action builder`)
    }
    const calls: FunctionCall[] = []
    const chainId = batch.chainId

    //add "approve" for each token we lock
    this.voucherRequest.tokens
      .filter(asset => toAddress(chainId, asset.token) !== NATIVE_ETH)
      .forEach(asset => {
        calls.push({
          target: asset.token,
          functionName: 'approve',
          args: [paymasterAddr, asset.amount],
        })
      })

    calls.push({
      target: batch.config.paymasters,
      functionName: 'lockUserDeposit',
      value: this.nativeAmount,
      args: [voucherRequest],
    })

    return calls
  }
}
