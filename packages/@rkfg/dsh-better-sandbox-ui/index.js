/**
 * @rkfg/dsh-better-sandbox-ui: the package's only host-side entry.
 *
 * A package that ships a client half must have exactly one loader entry, which is
 * why the UI lives in its own bundle rather than inside @rkfg/dsh-better-sandbox.
 * There is no logic here: the harness settings layer reads and writes the rules.
 *
 * @module @rkfg/dsh-better-sandbox-ui
 */
import { Service } from '@deepseek-ai/cordis'

export default class BetterSandboxUi extends Service {
  constructor(ctx) {
    super(ctx, 'betterSandboxUi')
  }
}
