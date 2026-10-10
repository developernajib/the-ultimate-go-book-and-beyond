## Extended Scenarios: International Trips and Accessibility

### Handling Currency Conversion for International Trips

When a rider takes a trip in a foreign country:

1. **Pricing in local currency**: Fare calculated using the local city's rate card
2. **Rider charged in home currency**: Convert using mid-market exchange rate plus a spread
3. **Exchange rate lock**: Rate locked at trip start to prevent mid-trip fluctuation
4. **Driver paid in local currency**: Always paid in the currency of the city they operate in
5. **Reconciliation**: Finance team handles multi-currency settlement daily

Currency conversion is where the integer-minor-unit discipline earns its keep, and where it needs the most care. Two rules.

Never assume the exponent is 2 on either side. A ¥3,000 fare is the integer `3000` with exponent 0, while $20.00 is `2000` with exponent 2. Converting by multiplying minor units directly, without normalizing through each currency's exponent, produces an answer that is wrong by a factor of 100 and looks entirely plausible.

Round exactly once, at the end, and store both sides. Persist the local amount, the charged amount, the rate, and the exponent for each. If you keep only the converted total, you cannot later prove what the rider was quoted, and every FX dispute becomes unanswerable. The conversion is lossy by nature, so the audit trail is the only thing that makes it defensible.

### Handling Peak Hour Driver Supply Management

To ensure sufficient driver supply during predictable peak hours (morning commute, evening rush):

1. **Predictive demand modeling**: ML model trained on historical trip data per H3 cell per hour
2. **Supply incentives**: "Earn 1.5x during 7-9 AM in downtown", targeted push notifications to drivers
3. **Pre-positioning suggestions**: "Drive to Market Street area, high demand expected in 15 minutes"
4. **Minimum earnings guarantee**: "Earn at least $25/hour between 5-7 PM or the platform pays the difference"
5. **Dynamic surge smoothing**: Instead of a sudden 3x spike, ramp the multiplier gradually. This is the production form of the step function in the surge engine, where a single extra request crossing a band boundary jumps the fare from 1.2x to 1.5x for everyone in the cell.
6. **Post-event scheduling**: For known events (concerts, sports), pre-schedule driver bonuses 24 hours in advance

---
