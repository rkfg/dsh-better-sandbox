/**
 * @rkfg/dsh-sandbox-allowlist-ui: the package's only host-side entry.
 *
 * A package that ships a client half must have exactly one loader entry, which is
 * why the UI lives in its own bundle rather than inside @rkfg/dsh-sandbox-allowlist.
 * There is no logic here: the harness settings layer reads and writes the rules.
 *
 * @module @rkfg/dsh-sandbox-allowlist-ui
 */
import { Service } from '@deepseek-ai/cordis'

export default class SandboxAllowlistUi extends Service {
  constructor(ctx) {
    super(ctx, 'sandboxAllowlistUi')
  }
}
