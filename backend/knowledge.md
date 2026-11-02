# DivOS business knowledge

Claude reads this file with every question. Keep it short and factual.

## Terms
- "pending truck" or "pending trip" = a document in `trucktrips` whose `status` is not done/complete/delivered/dispatched and whose `placementStatus` is not done/complete.
- "pending plan" = a `truckplans` document whose `status` is empty, draft, pending, or open. `pendingPlacements` on that document is the count still to place.
- "truck" in a dispatch question means `trucktrips` (one trip: vehicle, destination, orders). The `trucks` collection is the vehicle master (`truckNumber`, `capacity`, `truckType`), not a trip.
- "DO" or "order" = a document in `orders`. `poNumber` is the purchase-order number. `status` is the order status. Money fields include `total`, `billingAmount`, and `totalPayableAmount`.
- "client" = `clients`. A delivery party on an order may be a `consignees` document.
- "stock" = `stockplannings` (product, sizeA, sizeB, gsm, quantity). Recovered stock is `stockrecoveries` (`orderNo`, `moNo`, `customerName`).
- "packing" = `bulkpackings` and `bundlepackings`.
- "leave" = `leaverequests` (`userId`, `fromDate`, `toDate`, `status`). Leave kinds are `leavetypes`. Company holidays are `holidays`.
- "people" or "candidate" = the `people` collection (applicants: `fullName`, `status`, `location`). Office logins are `users` (`name`, `email`, `role`), not `people`.

## Where data lives
- Dispatch: `truckplans` (planName, status, date, pendingPlacements, createdBy) and `trucktrips` (parentPlanId, planId, truckNumber, truckLabel, destination, status, placementStatus, orders, weight, transporter).
- Orders: `orders` (clientId, items, status, poNumber, billingAmount, totalPayableAmount, deliveryAddress).
- Stock and packing: `stockplannings`, `stockrecoveries`, `bulkpackings`, `bundlepackings`.
- HR: `leaverequests`, `leavetypes`, `holidays`, `people`.

## Example questions → how to answer
- "how many trucks are pending?" → count `trucktrips` that are not done/complete/delivered/dispatched and whose placement is not done/complete. Do not count the `trucks` master.
- "pending plans?" → count `truckplans` with status empty, draft, pending, or open. Use `pendingPlacements` when the question is about placements left on a plan.
- "kitne orders aaj aaye?" → count `orders` whose `createdAt` is today.
- "who is on leave?" → `leaverequests` with status approved whose dates include today. A Team Member may only see their own request.
- "stock of a product?" → `stockplannings` matched on `product` (and `gsm` / size when the question includes them).

## Official questions
These always use the definitions above. Do not invent another meaning.
- "How many trucks are pending?"
- "Kitne orders aaj aaye?"
- "Who is on leave today?"

A person's work location is `profile.workLocation`. Orders and truck trips are not stored per unit, so those answers cover the whole company. Leave still follows the person's role.
