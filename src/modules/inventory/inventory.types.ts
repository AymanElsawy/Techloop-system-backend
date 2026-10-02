export enum MovementType {
  RECEIVE = 'RECEIVE', // وارد: goods enter a warehouse
  ISSUE = 'ISSUE', // صرف: warehouse to rep custody
  RETURN = 'RETURN', // مرتجع: rep custody back to the warehouse
  SALE = 'SALE', // invoice, taken from custody first, then the rep's warehouse
  SALE_CANCEL = 'SALE_CANCEL', // cancelled invoice, stock put back where it came from
  SALE_RETURN = 'SALE_RETURN', // customer returned goods: into the rep's custody, or a warehouse for managers
  SALE_RETURN_CANCEL = 'SALE_RETURN_CANCEL', // cancelled return, goods taken out again
  ADJUST = 'ADJUST', // تسوية جرد: counted stock differs; item quantities are signed (+ surplus, − shortage)
  TRANSFER = 'TRANSFER', // تحويل: main stock of one warehouse to another (toWarehouse)
}
