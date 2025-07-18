/**
 * Determine pricing of given token representations.
 *
 * TODO:
 * - Use [ExecutionPlan](https://effect.website/blog/releases/effect/316/#executionplan-module)
 *   to fallback to different pricing sources.
 * - Can `Pricing.Default` layer expose the execution plan?
 * - Make mainnet vs testnet distinction.
 * - (optional) Match selection of potential services by chain if source is chain-specific.
 * - (optional) Allow for choosing localized currency such as not to hardcode USD.
 */
import {
  Array as A,
  BigDecimal,
  Context,
  Data,
  Effect,
  ExecutionPlan,
  Layer,
  Match,
  Number as N,
  Option as O,
  Record as R,
  Schedule,
  Schema as S,
  Stream,
} from "effect"
import { flow, pipe } from "effect/Function"
import { GAS_DENOMS } from "./constants/gas-denoms.js"
import { UniversalChainId } from "./schema/chain.js"

export class PriceError extends Data.TaggedError("@unionlabs/sdk/PriceOracle/PriceError")<{
  message: string
  cause?: unknown
}> {}

export const PriceSource = S.Struct({
  url: S.URL,
})
export type PriceSource = typeof PriceSource.Type

export const PriceResult = S.Struct({
  price: S.BigDecimalFromNumber.pipe(
    S.positiveBigDecimal(),
    S.annotations({
      arbitrary: () => (fc) =>
        fc.float({ min: Math.fround(0.1), max: Math.fround(200) }).map(BigDecimal.unsafeFromNumber),
    }),
  ),
  source: PriceSource,
})
export type PriceResult = typeof PriceResult.Type

export declare namespace PriceOracle {
  export interface Service {
    readonly of: (id: UniversalChainId) => Effect.Effect<PriceResult, PriceError>
    readonly ratio: (from: UniversalChainId, to: UniversalChainId) => Effect.Effect<{
      ratio: BigDecimal.BigDecimal
      source: PriceSource
      destination: PriceSource
    }, PriceError>
    readonly stream: (id: UniversalChainId) => Stream.Stream<PriceResult, PriceError>
  }
}

export class PriceOracle extends Context.Tag("@unionlabs/sdk/PriceOracle")<
  PriceOracle,
  PriceOracle.Service
>() {}

const Pyth = Layer.effect(
  PriceOracle,
  Effect.gen(function*() {
    const symbolFromId = Effect.fn("symbolFromId")(
      (id: UniversalChainId) =>
        pipe(
          R.get(GAS_DENOMS, id),
          O.map(x => x.tickerSymbol),
          Effect.mapError((cause) =>
            new PriceError({
              message: `No price ID mapping for ${id}`,
              cause,
            })
          ),
        ),
    )

    const { HermesClient } = yield* Effect.tryPromise({
      try: () => import("@pythnetwork/hermes-client"),
      catch: (cause) =>
        new PriceError({
          message: "Unable to import Hermes client.",
          cause,
        }),
    })

    const queryPriceFeed = yield* (Effect.cachedFunction((symbol: string) =>
      pipe(
        Effect.tryPromise({
          try: () =>
            client.getPriceFeeds({
              query: `${symbol}/USD`,
              assetType: "crypto",
            }),

          catch: (cause) =>
            new PriceError({
              message: `Failed to fetch pricing feed for ${symbol}.`,
              cause,
            }),
        }),
      )
    ))

    // TODO: move URL resource into dependency
    const client = new HermesClient("https://hermes.pyth.network")

    // TODO: probably make this accept variadic arguments or ensure array; alternatively
    //       this can be abstracted or implement concurrency/batching
    const feedIdOf = yield* Effect.cachedFunction(
      Effect.fn("feedIdOf")((symbol: string) =>
        pipe(
          queryPriceFeed(symbol),
          // TODO: move into helper or extend `queryPriceFeed`
          Effect.flatMap(flow(
            A.findFirst(x =>
              // TODO: check safely
              x.attributes["base"] === symbol && x.attributes["quote_currency"] === "USD"
            ),
            O.map(({ id, attributes }) => ({
              id,
              url: `https://www.pyth.network/price-feeds/${
                attributes["asset_type"].toLowerCase()
              }-${attributes["base"].toLowerCase()}-${attributes["quote_currency"].toLowerCase()}`,
            })),
          )),
          Effect.catchTag(
            "NoSuchElementException",
            (cause) =>
              new PriceError({
                message: `Failed to capture feed ID for ${symbol}.`,
                cause,
              }),
          ),
        )
      ),
    )

    const getLatestPriceUpdate = Effect.fn("getLatestPriceUpdates")(
      (id: string) =>
        pipe(
          Effect.tryPromise({
            try: () => client.getLatestPriceUpdates([id], { parsed: true }),
            catch: (cause) =>
              new PriceError({
                message: `Failed to fetch price for feed ID ${id}`,
                cause,
              }),
          }),
          Effect.map(
            ({ parsed }) => {
              const { price: { price, expo } } = (parsed as NonNullable<typeof parsed>)[0]
              return +price * Math.pow(10, expo)
            },
          ),
        ),
    )

    // XXX: reduce cache
    const of: PriceOracle.Service["of"] = yield* Effect.cachedFunction(flow(
      symbolFromId,
      Effect.flatMap(feedIdOf),
      Effect.flatMap(({ id, url }) =>
        pipe(
          getLatestPriceUpdate(id),
          Effect.map((price) =>
            PriceResult.make({
              price: BigDecimal.unsafeFromNumber(price),
              source: PriceSource.make({
                url: new URL(url),
              }),
            })
          ),
          Effect.tapError((cause) => Effect.logError("PriceOracle.of", cause)),
        )
      ),
    ))

    return PriceOracle.of({
      of,
      stream: () => Stream.fail(new PriceError({ message: "not implemented" })),
      ratio: Effect.fn(function*(a, b) {
        const [ofA, ofB] = yield* Effect.all([of(a), of(b)], { concurrency: 2 })
        const ratio = yield* BigDecimal.divide(ofA.price, ofB.price).pipe(
          Effect.map(BigDecimal.round({ scale: 4, mode: "from-zero" })),
          Effect.tap((x) => Effect.logDebug(`Dividing ${ofA.price} by ${ofB.price} to get ${x}`)),
          Effect.mapError((cause) =>
            new PriceError({
              message: `Could not divide ${ofA.price} by ${ofB.price}.`,
              cause,
            })
          ),
        )

        return {
          ratio,
          source: ofA.source,
          destination: ofB.source,
        } as const
      }),
    })
  }),
)
/**
 * https://app.redstone.finance
 */
const Redstone = Layer.effect(
  PriceOracle,
  Effect.gen(function*() {
    const DATA_SERVICE_ID = "redstone-primary-prod"

    const { requestDataPackages, getOracleRegistryState } = yield* Effect.tryPromise({
      try: () => import("@redstone-finance/sdk"),
      catch: (cause) =>
        new PriceError({
          message: "Unable to import Redstone SDK.",
          cause,
        }),
    })

    const getRegistryState = yield* Effect.cached(
      Effect.tryPromise({
        try: () => getOracleRegistryState(),
        catch: (cause) =>
          new PriceError({
            message: "Could not fetch Redstone registry state",
            cause,
          }),
      }),
    )

    const getAuthorizedSigners = yield* Effect.cached(pipe(
      getRegistryState,
      Effect.map(flow(
        x => x.nodes,
        x => {
          console.log({ nodes: x })
          return x
        },
        R.values,
        A.filter(x => x.dataServiceId === DATA_SERVICE_ID),
        A.map(x => x.evmAddress),
      )),
    ))
    const getDataPackagesForSymbol = Effect.fn("getDataPackagesForSymbol")((symbol: string) =>
      pipe(
        getAuthorizedSigners,
        Effect.andThen((authorizedSigners) =>
          Effect.tryPromise({
            try: () =>
              requestDataPackages({
                dataServiceId: "redstone-primary-prod", // production-grade service
                dataPackagesIds: [symbol],
                uniqueSignersCount: 2, // security via multiple signers
                maxTimestampDeviationMS: 60 * 1000, // tolerate 1 min clock skew
                authorizedSigners,
              }),
            catch: (cause) =>
              new PriceError({
                message: `Could not fetch data packages for ${symbol}`,
                cause,
              }),
          })
        ),
      )
    )

    const priceOfSymbol = Effect.fn("getDataPackageByChain")((symbol: string) =>
      pipe(
        getDataPackagesForSymbol(symbol),
        Effect.flatMap((r) =>
          pipe(
            r[symbol], // don't know why R.get isn't valid here
            O.fromNullable,
            Effect.mapError(() =>
              new PriceError({
                message: `No data package returned for ${symbol}`,
              })
            ),
          )
        ),
        Effect.flatMap(flow(
          A.flatMap(x => x.dataPackage.dataPoints),
          A.map(x => x.toObj().value),
          A.filterMap(
            Match.type<number | string>().pipe(
              Match.when(Match.number, O.some<number>),
              Match.when(Match.string, N.parse),
              Match.exhaustive,
            ),
          ),
          O.liftPredicate(A.isNonEmptyArray),
          Effect.mapError(() =>
            new PriceError({
              message: "Data points is an empty array",
            })
          ),
          Effect.map(xs => A.reduce(xs, 0, (acc, x) => acc + x) / A.length(xs)),
        )),
        Effect.flatMap(x =>
          pipe(
            BigDecimal.safeFromNumber(x),
            Effect.mapError(() =>
              new PriceError({
                message: `Could not parse ${x} to a BigDecimal`,
              })
            ),
          )
        ),
      )
    )
    const of: PriceOracle.Service["of"] = Effect.fn("of")((id) =>
      pipe(
        R.get(GAS_DENOMS, id),
        Effect.mapError(() =>
          new PriceError({
            message: `ID ${id} does not exist in GAS_DENOMS`,
          })
        ),
        Effect.map(x => x.tickerSymbol),
        Effect.flatMap((symbol) =>
          pipe(
            priceOfSymbol(symbol),
            Effect.map((price) => ({
              price,
              source: {
                url: new URL(`https://app.redstone.finance/app/token/${symbol}/`),
              },
            })),
          )
        ),
        Effect.tapError((cause) => Effect.logError("PriceOracle.of", cause)),
      )
    )

    return PriceOracle.of({
      of,
      ratio: Effect.fn(function*(a, b) {
        const [ofA, ofB] = yield* Effect.all([of(a), of(b)], { concurrency: 2 })
        const ratio = yield* BigDecimal.divide(ofA.price, ofB.price).pipe(
          Effect.mapError((cause) =>
            new PriceError({
              message: `Could not divide ${ofA.price} by ${ofB.price}.`,
              cause,
            })
          ),
        )

        return {
          ratio,
          source: ofA.source,
          destination: ofB.source,
        } as const
      }),
      stream: () => Stream.fail(new PriceError({ message: "not implemented" })),
    })
  }),
)

export const LivePlan = ExecutionPlan.make(
  {
    provide: Pyth,
    attempts: 2,
    schedule: Schedule.exponential("100 millis", 1.5),
  },
  {
    provide: Redstone,
    attempts: 2,
    schedule: Schedule.exponential("100 millis", 1.5),
  },
)

// TODO: rename to just "Executor" 8)
export class PriceOracleExecutor
  extends Effect.Service<PriceOracle>()("@unionlabs/sdk/PriceOracle", { // XXX: is this a sin?
    effect: Effect.gen(function*() {
      const ctx = PriceOracle

      return PriceOracle.of({
        of: (id: UniversalChainId) =>
          pipe(
            ctx,
            Effect.andThen((oracle) => oracle.of(id)),
            Effect.withExecutionPlan(LivePlan),
          ),
        stream: () => Stream.fail(new PriceError({ message: "not implemented" })),
        ratio: (from: UniversalChainId, to: UniversalChainId) =>
          pipe(
            ctx,
            Effect.andThen((oracle) => oracle.ratio(from, to)),
            Effect.withExecutionPlan(LivePlan),
          ),
      })
    }),
  })
{
  static Test = Layer.effect(
    PriceOracle,
    Effect.gen(function*() {
      const fc = yield* Effect.tryPromise({
        try: () => import("effect/FastCheck"),
        catch: (cause) =>
          new PriceError({
            message: `Could not import "effect/FastCheck"`,
            cause,
          }),
      })

      const Arbitrary = yield* Effect.tryPromise({
        try: () => import("effect/Arbitrary"),
        catch: (cause) =>
          new PriceError({
            message: `Could not import "effect/Arbitrary"`,
            cause,
          }),
      })

      const ArbitraryPriceResult = Arbitrary.make(PriceResult)

      const of: PriceOracle.Service["of"] = () =>
        pipe(
          fc.sample(ArbitraryPriceResult, 1)[0],
          Effect.succeed,
        )

      const stream: PriceOracle.Service["stream"] = () =>
        pipe(
          fc.infiniteStream(ArbitraryPriceResult),
          (arb) => fc.sample(arb, 1)[0],
          Stream.fromIterable,
          Stream.schedule(Schedule.spaced("3 seconds")),
        )

      const ratio: PriceOracle.Service["ratio"] = Effect.fn(function*(a, b) {
        const [ofA, ofB] = yield* Effect.all([of(a), of(b)], { concurrency: 2 })
        const ratio = yield* BigDecimal.divide(ofA.price, ofB.price).pipe(
          Effect.mapError((cause) =>
            new PriceError({
              message: `Could not divide ${ofA.price} by ${ofB.price}.`,
              cause,
            })
          ),
        )

        return {
          ratio,
          source: ofA.source,
          destination: ofB.source,
        } as const
      })

      return PriceOracle.of({
        of,
        stream,
        ratio,
      })
    }),
  )
}
