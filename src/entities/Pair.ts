import {
  FACTORY_ADDRESS,
  FIVE,
  ZERO,
  TEN,
  _18,
  _997,
  _1000,
} from '../constants'
import {
  InsufficientInputAmountError,
  InsufficientReservesError,
} from '../errors'

import { BigintIsh } from '../types'
import { CurrencyAmount } from './CurrencyAmount'
import JSBI from 'jsbi'
import { Price } from './Price'
import { Token } from './Token'
import { computePairAddress } from '../functions/computePairAddress'
import invariant from 'tiny-invariant'
import { sqrt } from '../functions/sqrt'

export class Pair {
  public readonly liquidityToken: Token
  private readonly tokenAmounts: [CurrencyAmount<Token>, CurrencyAmount<Token>]

  public static getAddress(tokenA: Token, tokenB: Token): string {
    return computePairAddress({
      factoryAddress: FACTORY_ADDRESS[tokenA.chainId],
      tokenA,
      tokenB,
    })
  }

  public constructor(
    currencyAmountA: CurrencyAmount<Token>,
    tokenAmountB: CurrencyAmount<Token>
  ) {
    const tokenAmounts = currencyAmountA.currency.sortsBefore(
      tokenAmountB.currency
    ) // does safety checks
      ? [currencyAmountA, tokenAmountB]
      : [tokenAmountB, currencyAmountA]
    this.liquidityToken = new Token(
      tokenAmounts[0].currency.chainId,
      Pair.getAddress(tokenAmounts[0].currency, tokenAmounts[1].currency),
      18,
      'UNI-V2',
      'Uniswap V2'
    )
    this.tokenAmounts = tokenAmounts as [
      CurrencyAmount<Token>,
      CurrencyAmount<Token>
    ]
  }

  /**
   * Returns true if the token is either token0 or token1
   * @param token to check
   */
  public involvesToken(token: Token): boolean {
    return token.equals(this.token0) || token.equals(this.token1)
  }

  /**
   * Returns the current mid price of the pair in terms of token0, i.e. the ratio of reserve1 to reserve0
   */
  public get token0Price(): Price<Token, Token> {
    const result = this.tokenAmounts[1].divide(this.tokenAmounts[0])
    return new Price(
      this.token0,
      this.token1,
      result.denominator,
      result.numerator
    )
  }

  /**
   * Returns the current mid price of the pair in terms of token1, i.e. the ratio of reserve0 to reserve1
   */
  public get token1Price(): Price<Token, Token> {
    const result = this.tokenAmounts[0].divide(this.tokenAmounts[1])
    return new Price(
      this.token1,
      this.token0,
      result.denominator,
      result.numerator
    )
  }

  /**
   * Return the price of the given token in terms of the other token in the pair.
   * @param token token to return price of
   */
  public priceOf(token: Token): Price<Token, Token> {
    invariant(this.involvesToken(token), 'TOKEN')
    return token.equals(this.token0) ? this.token0Price : this.token1Price
  }

  /**
   * Returns the chain ID of the tokens in the pair.
   */
  public get chainId(): number {
    return this.token0.chainId
  }

  public get token0(): Token {
    return this.tokenAmounts[0].currency
  }

  public get token1(): Token {
    return this.tokenAmounts[1].currency
  }

  public get reserve0(): CurrencyAmount<Token> {
    return this.tokenAmounts[0]
  }

  public get reserve1(): CurrencyAmount<Token> {
    return this.tokenAmounts[1]
  }

  public reserveOf(token: Token): CurrencyAmount<Token> {
    invariant(this.involvesToken(token), 'TOKEN')
    return token.equals(this.token0) ? this.reserve0 : this.reserve1
  }

  public quote(inputAmount: JSBI, decimalsIn: number, decimalsOut: number): JSBI {
    if (decimalsIn > decimalsOut) {
      return JSBI.divide(inputAmount, JSBI.exponentiate(TEN, JSBI.BigInt(decimalsIn - decimalsOut)))
    }
    return JSBI.multiply(inputAmount, JSBI.exponentiate(TEN, JSBI.BigInt(decimalsOut - decimalsIn)))
  }

  public getOutputAmount(
    inputAmount: CurrencyAmount<Token>
  ): [CurrencyAmount<Token>, Pair] {
    invariant(this.involvesToken(inputAmount.currency), 'TOKEN')
    if (
      JSBI.equal(this.reserve0.quotient, ZERO) ||
      JSBI.equal(this.reserve1.quotient, ZERO)
    ) {
      throw new InsufficientReservesError()
    }
    const inputReserve = this.reserveOf(inputAmount.currency)
    const outputReserve = this.reserveOf(
      inputAmount.currency.equals(this.token0) ? this.token1 : this.token0
    )
    const inputAmountWithFee = JSBI.divide(JSBI.multiply(inputAmount.quotient, _997), _1000)
    
    const outputAmount = CurrencyAmount.fromRawAmount(
      inputAmount.currency.equals(this.token0) ? this.token1 : this.token0,
      this.quote(inputAmountWithFee, inputReserve.currency.decimals, outputReserve.currency.decimals)
    )
    if (outputAmount.greaterThan(outputReserve)) {
      throw new InsufficientInputAmountError()
    }
    return [
      outputAmount,
      new Pair(
        inputReserve.add(inputAmount),
        outputReserve.subtract(outputAmount)
      ),
    ]
  }

  public getInputAmount(
    outputAmount: CurrencyAmount<Token>
  ): [CurrencyAmount<Token>, Pair] {
    invariant(this.involvesToken(outputAmount.currency), 'TOKEN')
    if (
      JSBI.equal(this.reserve0.quotient, ZERO) ||
      JSBI.equal(this.reserve1.quotient, ZERO) ||
      JSBI.greaterThanOrEqual(
        outputAmount.quotient,
        this.reserveOf(outputAmount.currency).quotient
      )
    ) {
      throw new InsufficientReservesError()
    }

    const outputReserve = this.reserveOf(outputAmount.currency)
    const inputReserve = this.reserveOf(
      outputAmount.currency.equals(this.token0) ? this.token1 : this.token0
    )

    const inputAmountAfterFee = this.quote(outputAmount.quotient, outputReserve.currency.decimals, inputReserve.currency.decimals)

    const inputAmount = CurrencyAmount.fromRawAmount(
      outputAmount.currency.equals(this.token0) ? this.token1 : this.token0,
      JSBI.divide(JSBI.multiply(inputAmountAfterFee, _1000), _997)
    )
    return [
      inputAmount,
      new Pair(
        inputReserve.add(inputAmount),
        outputReserve.subtract(outputAmount)
      ),
    ]
  }

  public computeLiquidityUnit(_reserve0: JSBI, _reserve1: JSBI, decimals0: number, decimals1: number): JSBI {
    if (decimals0 > decimals1) {
      return JSBI.add(_reserve0, JSBI.multiply(_reserve1, JSBI.exponentiate(TEN, JSBI.BigInt(decimals0 - decimals1))))
    } else {
      return JSBI.add(_reserve1, JSBI.multiply(_reserve0, JSBI.exponentiate(TEN, JSBI.BigInt(decimals1 - decimals0))))
    }
  }

  public getLiquidityMinted(
    totalSupply: CurrencyAmount<Token>,
    tokenAmountA: CurrencyAmount<Token>,
    tokenAmountB: CurrencyAmount<Token>
  ): CurrencyAmount<Token> {
    invariant(totalSupply.currency.equals(this.liquidityToken), 'LIQUIDITY')
    const tokenAmounts = tokenAmountA.currency.sortsBefore(
      tokenAmountB.currency
    ) // does safety checks
      ? [tokenAmountA, tokenAmountB]
      : [tokenAmountB, tokenAmountA]
    invariant(
      tokenAmounts[0].currency.equals(this.token0) &&
        tokenAmounts[1].currency.equals(this.token1),
      'TOKEN'
    )

    const decimals0 = tokenAmountA.currency.decimals
    const decimals1 = tokenAmountB.currency.decimals
    const addedLiquidityUnit = this.computeLiquidityUnit(tokenAmountA.quotient, tokenAmountB.quotient, decimals0, decimals1)
    const reserveLiquidityUnit = this.computeLiquidityUnit(this.reserve0.quotient, this.reserve1.quotient, decimals0, decimals1)
    let liquidity: JSBI

    if (JSBI.equal(totalSupply.quotient, ZERO)) {
      const biggerDecimals = decimals0 > decimals1 ? decimals0 : decimals1
      liquidity = JSBI.divide(
        JSBI.multiply(addedLiquidityUnit, JSBI.exponentiate(TEN, _18)),
        JSBI.exponentiate(TEN, JSBI.BigInt(biggerDecimals))
      )
    } else {
      liquidity = JSBI.divide(
        JSBI.multiply(addedLiquidityUnit, totalSupply.quotient),
        reserveLiquidityUnit
      )
    }

    if (!JSBI.greaterThan(liquidity, ZERO)) {
      throw new InsufficientInputAmountError()
    }
    return CurrencyAmount.fromRawAmount(this.liquidityToken, liquidity)
  }

  public getLiquidityValue(
    token: Token,
    totalSupply: CurrencyAmount<Token>,
    liquidity: CurrencyAmount<Token>,
    feeOn: boolean = false,
    kLast?: BigintIsh
  ): CurrencyAmount<Token> {
    invariant(this.involvesToken(token), 'TOKEN')
    invariant(totalSupply.currency.equals(this.liquidityToken), 'TOTAL_SUPPLY')
    invariant(liquidity.currency.equals(this.liquidityToken), 'LIQUIDITY')
    invariant(
      JSBI.lessThanOrEqual(liquidity.quotient, totalSupply.quotient),
      'LIQUIDITY'
    )

    let totalSupplyAdjusted: CurrencyAmount<Token>
    if (!feeOn) {
      totalSupplyAdjusted = totalSupply
    } else {
      invariant(!!kLast, 'K_LAST')
      const kLastParsed = JSBI.BigInt(kLast)
      if (!JSBI.equal(kLastParsed, ZERO)) {
        const rootK = sqrt(
          JSBI.multiply(this.reserve0.quotient, this.reserve1.quotient)
        )
        const rootKLast = sqrt(kLastParsed)
        if (JSBI.greaterThan(rootK, rootKLast)) {
          const numerator = JSBI.multiply(
            totalSupply.quotient,
            JSBI.subtract(rootK, rootKLast)
          )
          const denominator = JSBI.add(JSBI.multiply(rootK, FIVE), rootKLast)
          const feeLiquidity = JSBI.divide(numerator, denominator)
          totalSupplyAdjusted = totalSupply.add(
            CurrencyAmount.fromRawAmount(this.liquidityToken, feeLiquidity)
          )
        } else {
          totalSupplyAdjusted = totalSupply
        }
      } else {
        totalSupplyAdjusted = totalSupply
      }
    }

    return CurrencyAmount.fromRawAmount(
      token,
      JSBI.divide(
        JSBI.multiply(liquidity.quotient, this.reserveOf(token).quotient),
        totalSupplyAdjusted.quotient
      )
    )
  }
}
