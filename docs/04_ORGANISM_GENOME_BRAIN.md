# 04 — Organisms, Genome, Physiology and Neural Brain

## 1. Organism philosophy

An organism has no hard-coded role such as “wolf” or “rabbit”. It receives:

- inherited quantitative genome;
- phenotype;
- energy/health/development;
- generic sensors;
- inherited neural controller;
- generic actions.

Ecological roles must emerge.

## 2. MVP ecological genome

Use 16 genes:

1. `adultSize`
2. `maxSpeed`
3. `acceleration`
4. `turnRate`
5. `visionRange`
6. `visionFov`
7. `diet`
8. `attackPower`
9. `armor`
10. `metabolicPace`
11. `thermalOptimum`
12. `thermalTolerance`
13. `maturityAge`
14. `maxAge`
15. `offspringInvestment`
16. `hue`

Mutation rate itself remains global in MVP; evolvable mutation rate is deferred.

Store ecological genes quantized, preferably Uint16. Map signed diet from Uint16 to `[-Q,Q]`.

## 3. Mapping rules

All mapping functions centralized and unit tested.

Numbers below are starting hypotheses, not sacred constants.

### Adult size

```text
adultRadiusLU = lerp(1.25, 4.50, size^1.35)
mass = MASS_SCALE * radius²
MASS_SCALE ≈ 100
```

Use LUT/integer approximation for nonlinear mapping if necessary.

Benefits: capacity/combat/robustness. Costs: growth, maintenance, movement.

### Speed

```text
geneMaxSpeed = lerp(0.035, 0.30, speed^1.25) LU/tick
effectiveMaxSpeed = geneMaxSpeed * (1 - 0.35 * armor)
```

High capability itself has muscle maintenance cost; actual movement adds more cost.

### Acceleration

```text
lerp(0.0015, 0.025, gene) LU/tick²
```

### Turn

```text
lerp(0.5°, 14°, gene) per tick
× (1 - 0.25 * sizeNorm)
```

Convert to angle steps.

### Vision range

```text
lerp(10, 96, gene^1.4) LU
```

### Vision FOV

```text
lerp(35°, 270°, gene)
```

Long+wide vision costs energy.

### Diet

Signed specialist trade-off defined in world/ecology spec.

### Attack

0..1. Raises contact damage and attack/maintenance energy cost.

### Armor

0..1. Mitigates damage; slows maximum speed; raises maintenance; visually thickens body.

### Metabolic pace

```text
lerp(0.65, 1.45, gene)
```

High pace:

- higher digestion/growth throughput;
- higher basal cost.

Low pace:

- cheaper idle life;
- slower throughput.

### Thermal optimum

```text
lerp(-10°C, +35°C, gene)
```

### Thermal tolerance

```text
lerp(3°C, 24°C, gene)
```

Wide tolerance has maintenance cost so maximum is not free.

### Maturity age

```text
lerp(400, 2200, gene) ticks
```

Fast maturity means faster development burden.

### Maximum age

```text
lerp(2200, 10000, gene) ticks
```

Long-life phenotype adds maintenance/repair cost.

### Offspring investment

```text
lerp(0.08, 0.35, gene) of parent's max energy
```

Trade-off: stronger child start vs parent energy/fewer births.

### Hue

0..359°.

Neutral in MVP except visible cue. Exclude hue from ecological species distance initially.

## 4. Growth/development

Birth size is not adult size.

```text
ageFraction = clamp(age / maturityAge, 0, 1)
targetGrowth = 0.45 + 0.55 * growthCurve(ageFraction)
```

First implementation can use linear or deterministic smoothstep.

Growth costs energy based on added mass.

If organism cannot pay growth cost, actual development lags target.

Reproduction requires:

- age >= maturity age;
- actual development >= 90%.

This prevents “instant early maturity” being a free dominant gene.

## 5. Energy

State:

```text
energy integer
maxEnergy derived from current mass
health 0..Q
```

Concept:

```text
maxEnergy = BASE_ENERGY + currentMass * ENERGY_PER_MASS
```

Initial founder energy 65–80%.

## 6. Basal cost

Per tick conceptual sum:

```text
base mass maintenance
+ muscle-capacity maintenance
+ vision maintenance
+ attack maintenance
+ armor maintenance
+ thermal-tolerance maintenance
+ longevity maintenance
```

Suggested forms:

```text
base ∝ mass * metabolicPace
muscle ∝ mass * maxSpeedNorm²
vision ∝ rangeNorm² * fovNorm
attack ∝ mass * attack²
armor ∝ mass * armor²
tolerance ∝ mass * toleranceNorm
longevity ∝ mass * maxAgeNorm
```

Centralize coefficients in config.

Every gene except hue should pass the audit question:

> Why would evolution ever select a lower value?

If there is no answer, add/adjust trade-off rather than species-specific bonus.

## 7. Movement energy

```text
movementCost ∝ mass * currentSpeedFraction² * terrainMultiplier
```

Optional small acceleration cost.

Water multiplier ≈ 4×.

## 8. Thermal stress

```text
delta = abs(localTemp - optimum)
```

If inside tolerance => no stress.

Else:

```text
excess = delta - tolerance
stress = clamp(excess / max(tolerance, minimum), 0, 2)
```

Effects:

- basal multiplier increases;
- severe excess causes health damage.

## 9. Starvation and healing

If costs exceed energy:

- energy becomes 0;
- apply starvation health damage;
- death at health <=0.

Optional default passive healing:

- only if energy >70%;
- only without severe thermal stress;
- costs energy.

No magical full healing after eating.

## 10. Neural architecture

Fixed topology for MVP.

### Inputs: 20

All normalized `[-Q,Q]`.

0. bias
1. energy ratio
2. health ratio
3. development/maturity state
4. local plant density
5. plant gradient forward
6. plant gradient lateral
7. carcass proximity
8. carcass forward
9. carcass lateral
10. visible creature proximity
11. creature forward
12. creature lateral
13. creature relative size
14. creature hue difference
15. thermal comfort/stress
16. local crowding
17. terrain/water danger forward
18. terrain danger lateral (left-vs-right avoidance cue)
19. internal oscillator/noise signal

If oscillator/noise later become separate inputs, this changes network/genome format and requires versioning.

### Hidden: 12

### Outputs: 5

0. throttle `[0,Q]`
1. turn `[-Q,Q]`
2. eat `[0,Q]`
3. attack `[0,Q]`
4. reproduce `[0,Q]`

### Connections

```text
20 inputs -> 12 hidden -> 5 outputs
20 inputs -------------> 5 outputs (skip)
```

Weights:

```text
20*12 = 240
12*5  = 60
20*5  = 100
TOTAL = 400 Int16 weights per organism
```

Skip connections make a viable founder reflex network easy while hidden features evolve.

## 11. Quantized inference

Suggested:

```ts
NN_VALUE_SCALE = 4096
NN_WEIGHT_SCALE = 4096
NN_WEIGHT_MIN = -8192
NN_WEIGHT_MAX = 8192
```

For neuron:

```text
sum = Σ input * weight
scaled = integerDivide(sum, WEIGHT_SCALE)
activation = clamp(scaled, -Q, Q)
```

Hard-tanh.

Output mapping:

- throttle/eat/attack/reproduce = `(raw + Q)/2`;
- turn = raw.

Use JS Number for integer accumulation; choose bounds safely below exact integer limit.

## 12. Creature vision

Find nearest visible organism:

- not self;
- in vision distance;
- inside FOV;
- no terrain occlusion in MVP;
- tie: lower distance², then lower entity ID.

Brain never receives species ID.

It may see phenotype cues:

- relative size;
- hue;
- motion indirectly later.

## 13. Local-coordinate sensing

Do not compute bearing with `atan2`.

For target vector, normalize approximately and project onto current heading:

```text
forward component = dot(targetDir, forwardBasis)
lateral component = dot(targetDir, rightBasis)
proximity = 1 - distance / range
```

Same for carcass.

Plant uses cached gradient.

## 14. Crowding

Count/weight nearby organisms inside configured radius using spatial hash.

Normalize to sensor range.

No friend/enemy interpretation.

## 15. Terrain lateral danger

Sample passability/water to the left and right of the heading. Encode positive when danger is greater on the left, negative when greater on the right. With the v0.1 turn convention, a positive founder weight turns away from the dangerous side.

## 16. Internal signal

Use deterministic triangular oscillator with per-entity phase plus optional stateless hash noise.

Do not advance global PRNG merely because renderer/query timing changes.

## 17. Founder brain

Do not spawn random brains and hope they survive.

Create a normal inheritable calibrated `FounderGenome` with skip weights encouraging:

- moderate movement/wander;
- turning toward positive plant gradient;
- water avoidance;
- eating in plant-rich cell;
- reproduction when mature/high energy;
- low baseline attack.

After spawn there is no special heuristic. Everything uses the same NN implementation.

Founder weights are fixture data and hash-tested.

## 18. Mutation

Asexual child:

1. copy 16 genes;
2. copy 400 weights;
3. mutate ecological genes;
4. mutate weights;
5. clamp;
6. derive phenotype.

### Ecological defaults

Initial hypotheses:

```text
perGene mutation probability   0.08
small sigma                    0.025 normalized
large mutation probability     0.005 per gene
large sigma                    0.15
reset probability              0.0002
```

### Brain defaults

```text
perWeight mutation probability 0.02
weight sigma                    0.06 weight units
large probability              0.001
```

At 400 weights, 2% ≈ 8 changed weights/birth.

Use deterministic summed-uniform approximate normal deltas.

No crossover.

## 19. Reproduction

Conditions:

- alive;
- age mature;
- development >=90%;
- brain reproduce output >= threshold;
- enough energy for child + minimum parent reserve;
- cooldown zero if cooldown used.

Child energy:

```text
parentMaxEnergy * offspringInvestmentFraction
```

Parent must retain e.g. >=20% max energy after birth.

Birth:

- deduct energy;
- allocate deterministic slot/ID;
- nearby spawn point from deterministic angle/radius;
- mutate copy;
- generation +1;
- parent ID;
- starts in parent species until species analysis.

At most one offspring per organism per tick.

Add configurable cooldown only if burst behavior destabilizes ecology.

## 20. Food action target

One `eat` output in MVP.

If carcass in mouth range and meat efficiency >= plant efficiency, attempt carcass; otherwise attempt plant.

This policy is deliberately simple and must be documented because it affects ecology.

Future brain may gain separate food actions if needed.

## 21. Combat

Attack requires:

- attack output over threshold;
- target in contact range;
- cooldown 0;
- energy available.

Concept:

```text
rawDamage = baseDamage * attackPower * massFactor * impactBonus
mitigation = 1 - maxArmorReduction * targetArmor
damage = rawDamage * mitigation
```

Initial max armor reduction ≈65%.

Attack costs energy scaled by mass/attack.

### Simultaneous damage

All attacks create damage claims.

Accumulate per target, then apply together.

Mutual kills possible.

Kill attribution:

- largest damage contributor;
- tie lower attacker ID.

## 22. Death

Causes:

```ts
Starvation
Combat
Thermal
OldAge
Drowning
Meteor
Other
```

MVP old age = deterministic hard maximum age.

On death:

- decrement species live population;
- create carcass;
- increment counters;
- release slot only after dependent phases finish.

## 23. Phenotype rendering derivation

Visual mapping:

- current size -> scale;
- speed -> elongation;
- armor -> body width/rim;
- vision -> eye size;
- attack -> front jaw/spike;
- hue -> tint;
- development -> juvenile size.

Far LOD only needs tint/scale/aspect.

## 24. Selected organism DTO

Expose:

- ID/parent/species/generation;
- age/maturity/max age/development;
- energy/max/health;
- x/y;
- biome/temp;
- lifetime plant/meat intake;
- kills;
- 16 genes in normalized + human units;
- derived speed/radius/costs/digestion;
- current NN outputs;
- debug-only sensor vector.
