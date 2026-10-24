/**
 * dsh-sandbox-allowlist-ui: единственная хостовая запись коробки.
 *
 * Пакет с клиентской половиной обязан иметь ровно одну запись загрузчика,
 * поэтому UI живёт отдельным бандлом, а не внутри dsh-sandbox-allowlist.
 * Никакой логики здесь нет: правила читает и пишет слой настроек харнесса.
 *
 * @module dsh-sandbox-allowlist-ui
 */
import { Service } from '@deepseek-ai/cordis'

export default class SandboxAllowlistUi extends Service {
  constructor(ctx) {
    super(ctx, 'sandboxAllowlistUi')
  }
}
