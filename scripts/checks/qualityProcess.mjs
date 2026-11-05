// 用途：为质量门和逐文件测试提供共享截止时间、进程树回收与有界诊断输出。
import { spawn, spawnSync } from 'node:child_process'

const OutputLimit = 128 * 1024

export function qualityDeadline(budgetMs, inherited = process.env.VELAROS_CHECK_DEADLINE) {
  const deadline = Date.now() + budgetMs
  if (inherited === undefined) return deadline
  const value = Number(inherited)
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid quality deadline')
  return Math.min(value, deadline)
}

export async function runQualityProcess(command, args, { cwd, deadline, signal, env = {} }) {
  const started = performance.now()
  const remaining = deadline - Date.now()
  if (remaining <= 0 || signal?.aborted)
    return { exitCode: null, timedOut: true, durationMs: 0, output: 'Quality budget exhausted' }
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let timedOut = false
    let escalation
    const append = (chunk) => {
      output = (output + chunk.toString()).slice(-OutputLimit)
    }
    const terminate = () => {
      if (timedOut) return
      timedOut = true
      if (!child.pid) return
      if (process.platform === 'win32') {
        spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          timeout: 3000,
          windowsHide: true,
          stdio: 'ignore',
        })
        child.kill('SIGKILL')
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM')
        } catch (error) {
          if (error.code !== 'ESRCH') append(error.message)
        }
        escalation = setTimeout(() => {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch (error) {
            if (error.code !== 'ESRCH') append(error.message)
          }
        }, 5500)
      }
    }
    const timer = setTimeout(terminate, remaining)
    signal?.addEventListener('abort', terminate, { once: true })
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.once('error', (error) => append(error.message))
    child.once('close', (exitCode, exitSignal) => {
      clearTimeout(timer)
      clearTimeout(escalation)
      if (timedOut && process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch (error) {
          if (error.code !== 'ESRCH') append(error.message)
        }
      }
      signal?.removeEventListener('abort', terminate)
      if (exitSignal && !timedOut) append(`\nProcess exited with signal ${exitSignal}\n`)
      resolve({
        exitCode,
        exitSignal,
        timedOut,
        durationMs: Math.round(performance.now() - started),
        output,
      })
    })
  })
}
