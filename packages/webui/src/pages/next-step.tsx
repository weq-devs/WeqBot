import { LogOut } from 'lucide-react';
import { motion } from 'motion/react';
import { useState } from 'react';
import { api } from '../api';
import { Button } from '../components/button';
import { Logo } from '../components/logo';
import { enterPop, enterRise, enterStagger, screenExit } from '../lib/motion';
import './gate/gate.css';

/**
 * 占位：令牌验证通过后的下一屏。
 *
 * 账号登录页（本机 login.db 账号 / 扫码）还在设计；先放一个能走通
 * 「验证 → 进入 → 退出控制台」的落点。
 */
export function NextStep({ onLocked }: { onLocked(): void }) {
  const [leaving, setLeaving] = useState(false);

  async function lock() {
    setLeaving(true);
    await api.auth.deleteSession();
    onLocked();
  }

  return (
    <motion.main
      className="gate"
      initial="hidden"
      animate="shown"
      exit={screenExit}
      variants={enterStagger}
    >
      <div className="gate-brand">
        <motion.div className="gate-logo" variants={enterPop}>
          <span className="gate-logo-halo" aria-hidden="true" />
          <Logo size={54} mood="happy" />
        </motion.div>
        <motion.h1 className="gate-title" variants={enterRise}>
          访问已验证
        </motion.h1>
        <motion.p className="gate-subtitle next-step-text" variants={enterRise}>
          下一步是账号登录：从本机 QQ 的登录记录里选账号，或者扫码登录。这一页还在设计中。
        </motion.p>
      </div>
      <motion.div variants={enterRise}>
        <Button variant="secondary" onClick={lock} disabled={leaving}>
          <LogOut size={15} aria-hidden="true" />
          退出控制台
        </Button>
      </motion.div>
    </motion.main>
  );
}
