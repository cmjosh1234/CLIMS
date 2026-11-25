package reports

// Every report names the date that places a record in its period (reporting requirements, receipt
// totals): notifications by when they were raised, receipts by when they were acknowledged, stock
// on its stock date. The same wording is returned on screen and written into exports.
const (
	raisedBasis       = "Date the notification was first raised, in Africa/Kampala. Deliveries and acknowledgements are included up to the data update time."
	requestedBasis    = "Date the district raised the request, in Africa/Kampala. Approvals, dispatches and receipts are included up to the data update time."
	acknowledgedBasis = "Date the hotspot manager acknowledged receipt, in Africa/Kampala."
	dispatchedBasis   = "Date the batch left the store under the exception, in Africa/Kampala."
	stockDateBasis    = "Stock held on the stock date; not limited to a reporting period."
)

// exportDateBasis is each exported report's date basis.
var exportDateBasis = map[string]string{
	"notifications":      raisedBasis,
	"warehouse-requests": requestedBasis,
	"stock":              stockDateBasis,
	"batches":            stockDateBasis,
	"expiry-exceptions":  dispatchedBasis,
	"hmis-105":           acknowledgedBasis,
	"hotspot-status":     hotspotStatusBasis,
	"consumption":        consumptionBasis,
}
