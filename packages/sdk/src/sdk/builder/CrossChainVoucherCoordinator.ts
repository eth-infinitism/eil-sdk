import { InternalVoucherInfo, SdkVoucherRequest } from '../types/index.js'
import { Address } from 'viem'

export class CrossChainVoucherCoordinator {

  /**
   * A mapping from the inputs of the Builder to the full voucher requests information for all batches.
   */
  private vouchersInternalInfo: Map<string, InternalVoucherInfo> = new Map()

  getAllVoucherInternalInfos (): InternalVoucherInfo[] {
    return [...this.vouchersInternalInfo.values()]
  }

  getVoucherInternalInfo (refId: string): InternalVoucherInfo | undefined {
    return this.vouchersInternalInfo.get(refId)
  }

  getAllOutVoucherRequests (): SdkVoucherRequest[] {
    return Array.from(this.vouchersInternalInfo.values()).map(info => info.voucher)
  }

  has (sdkVoucherRequest: SdkVoucherRequest): boolean {
    return this.vouchersInternalInfo.has(sdkVoucherRequest.ref)
  }

  set (internalVoucherInfo: InternalVoucherInfo): void {
    this.vouchersInternalInfo.set(internalVoucherInfo.voucher.ref, internalVoucherInfo)
  }

  updateVoucherXlps (voucherReq: SdkVoucherRequest, xlps: Address[]) {
    const info = this.vouchersInternalInfo.get(voucherReq.ref)
    if (!info) {
      throw new Error(`Voucher request ${voucherReq.ref} not found in action builder`)
    }
    info.allowedXlps = xlps
  }
}
