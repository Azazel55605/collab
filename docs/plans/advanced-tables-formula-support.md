# Advanced Tables Formula Support

This is the Phase 3 compatibility surface for `.sheet` formulas. Formula names,
argument separators, references, and decimal syntax are canonical and
locale-independent. Locale and app time settings affect display and volatile
time evaluation, not persisted formula source.

The executable baseline is pinned by
`crates/collab-sheet/tests/formula_proof.rs`. Autocomplete exposes the same
surface from `src/lib/sheet/formulaFunctions.ts`.

## Operators And References

| Feature                                             | Support                                                  |
| --------------------------------------------------- | -------------------------------------------------------- |
| Arithmetic, comparison, concatenation, parentheses  | Supported                                                |
| Relative, absolute, and mixed A1 references         | Supported                                                |
| Rectangular ranges                                  | Supported                                                |
| Cross-worksheet references, including quoted names  | Supported                                                |
| Insert, delete, move, and worksheet rename rewrites | Supported                                                |
| Copy and fill translation                           | Supported by the operation helper; UI arrives in Phase 4 |
| External workbook references                        | Not supported                                            |
| Dynamic array spill ranges                          | Not supported; returns `#SPILL!`                         |

## Functions

| Category  | Supported baseline                                                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------- |
| Aggregate | `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, `COUNTA`, `SUMIF`, `SUMIFS`, `COUNTIF`, `COUNTIFS`, `AVERAGEIF`, `AVERAGEIFS` |
| Logic     | `IF`, `IFS`, `AND`, `OR`, `NOT`, `IFERROR`                                                                             |
| Math      | `ROUND`, `ABS`, `MOD`, `SQRT`, `POWER`                                                                                 |
| Text      | `CONCAT`, `LEFT`, `RIGHT`, `MID`, `LEN`, `TRIM`                                                                        |
| Date/time | `DATE`, `YEAR`, `MONTH`, `DAY`, `TODAY`, `NOW`                                                                         |
| Lookup    | `INDEX`, `MATCH`, `VLOOKUP`, `HLOOKUP`, `XLOOKUP`                                                                      |

`CONCAT` with scalar arguments is supported. `CONCAT` and `TEXTJOIN` with range
arguments remain disabled as a compatibility claim because formualizer 0.7.1
collapses the range to its first cell. The pinned upstream-gap test prevents
this from being silently presented as correct.

## Errors And Bounds

| Condition                           | Display     |
| ----------------------------------- | ----------- |
| Invalid reference                   | `#REF!`     |
| Unknown function/name               | `#NAME?`    |
| Wrong value type                    | `#VALUE!`   |
| Division by zero                    | `#DIV/0!`   |
| Numeric failure                     | `#NUM!`     |
| Malformed source                    | `#ERROR!`   |
| Dependency cycle                    | `#CIRC!`    |
| Recognized but unsupported function | `#N/IMPL!`  |
| Evaluation budget exceeded          | `#TIMEOUT!` |

Each open workbook uses one native incremental runtime. A recalculation is
limited to 200,000 formula cells and five seconds. IPC is batched per committed
document change, never per cell or keystroke.

`TODAY()` and `NOW()` are bound once per recalculation request using the
calendar default timezone from the app settings. Every formula in that request
therefore observes the same instant. Computed values remain derived state and
are never serialized into the `.sheet` document.
