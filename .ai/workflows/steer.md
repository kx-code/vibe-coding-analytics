# Steer Workflow

After each bug fix or repeated failure:

1. Name the missing harness sensor.
2. Add the smallest durable sensor that would have caught it.
3. Verify the sensor fails before the fix and passes after.
4. Record the rule or decision so future agents inherit it.

A rule without a sensor decays. A sensor without context is hard to evolve.
