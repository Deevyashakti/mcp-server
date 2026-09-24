# DivOS business knowledge

Claude reads this file with every question. Add your company's terms, where
data lives, and example questions here — no restart needed, changes apply to
the next question. Keep it short and factual.

## Terms
- "pending truck" = a truck whose `status` is not done/complete/delivered/dispatched
  and whose `placementStatus` is not done/complete.
- "pending plan" = a truck plan whose `status` (or `planStatus`) is empty, draft, pending or open.
- TODO: add your short forms, e.g. "DO" = delivery order, "plant"/"unit"/"branch" = ...

## Where data lives
- Truck plans: the collection with "truck" and "plan" in its name. Each plan has a
  `trucks` array; each truck has fields like `vehicleNo`/`truckNumber`, `destination`,
  `status`, `placementStatus`.
- TODO: orders, users/employees, stock, leave, packing — which collection and key fields.

## Example questions → how to answer
- "how many trucks are pending?" → truck plan collection, $unwind trucks, count pending trucks.
- TODO: add real questions your team asks and how they should be answered.
