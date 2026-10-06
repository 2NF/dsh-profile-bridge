/**
 * dsh-profile-bridge — browser half.
 *
 * Adds one settings page that shows which profile this Harness is running, which
 * other profiles exist, and switches the app's profile directory to the one you
 * pick (or reverts that switch). All file work happens in the Host half.
 */
window.__ModuleLoader__.load({
  id: 'dsh-profile-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Shared RPC channel owned by this plugin's Host half. */
    const CHANNEL = '/profile-bridge'
    /** Locale namespace of this page. */
    const NS = 'profileBridge'

    const zh = {
      section: '配置档案',
      title: '配置档案桥接',
      subtitle: '让桌面版直接使用你已经装好插件的 profile，而不是它自带的空 profile。',
      current: '当前使用',
      linkedTo: '链接到',
      independent: '独立目录（未链接）',
      loading: '读取中…',
      refresh: '刷新',
      profiles: '可选的 profile',
      name: '名称',
      deps: '依赖',
      bundles: 'bundle',
      modules: 'node_modules',
      active: '使用中',
      use: '使用它',
      revert: '还原为独立 profile',
      working: '执行中…',
      closing: '桌面版即将自动关闭，几秒后会用所选 profile 重新打开。',
      cliHint: '当前 Harness 不是桌面版（probe 到的是普通 profile）。命令行用户直接用 dsh --profile <名称> 即可，不需要本页的链接。',
      noTargets: '没有别的 profile 可切换。',
      warnings: '提示',
      failure: '失败',
      log: '上次操作日志',
      logEmpty: '（还没有日志）',
      why: '桌面版把 profile 目录写死为 <DSH_HOME>/profiles/desktop，所以它看不到你其他 profile 里的插件。本页通过目录链接（Windows 用 junction，macOS/Linux 用符号链接）把两者接起来，原目录会先备份，随时可还原。',
      mustClose: '注意：切换需要关闭应用才能改目录，脚本会自动完成关闭与重启。',
      how: '工作原理',
    }
    const en = {
      section: 'Profiles',
      title: 'Profile bridge',
      subtitle: 'Make the Desktop app use the profile that already has your plugins instead of its own empty one.',
      current: 'Currently using',
      linkedTo: 'linked to',
      independent: 'standalone directory (not linked)',
      loading: 'Loading…',
      refresh: 'Refresh',
      profiles: 'Available profiles',
      name: 'Name',
      deps: 'deps',
      bundles: 'bundles',
      modules: 'node_modules',
      active: 'in use',
      use: 'Use this one',
      revert: 'Revert to a standalone profile',
      working: 'Working…',
      closing: 'The app will close by itself in a moment and reopen with the chosen profile.',
      cliHint: 'This Harness is not the Desktop app, so it already runs the profile you asked for. Command-line users can just pass dsh --profile <name>; the link below is unnecessary.',
      noTargets: 'There is no other profile to switch to.',
      warnings: 'Warnings',
      failure: 'Failed',
      log: 'Last operation log',
      logEmpty: '(no log yet)',
      why: 'The Desktop app hardcodes its profile directory to <DSH_HOME>/profiles/desktop, so plugins installed in your other profiles are invisible to it. This page links the two (a junction on Windows, a symlink elsewhere); the previous directory is backed up first and can be restored at any time.',
      mustClose: 'Note: the switch needs the app closed to move the directory, so the helper closes and restarts it for you.',
      how: 'How it works',
    }

    const styles = {
      page: { display: 'grid', gap: '14px', fontSize: '13px', lineHeight: 1.6, color: 'inherit', maxWidth: '720px' },
      title: { margin: 0, fontSize: '15px', fontWeight: 600 },
      subtitle: { margin: 0, opacity: 0.75 },
      card: { border: '1px solid rgba(127,127,127,0.35)', borderRadius: '10px', padding: '12px 14px', display: 'grid', gap: '8px' },
      code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', border: '1px solid rgba(127,127,127,0.35)', borderRadius: '5px', padding: '1px 6px' },
      button: { appearance: 'none', border: '1px solid rgba(127,127,127,0.4)', background: 'transparent', color: 'inherit', borderRadius: '8px', padding: '6px 12px', fontSize: '13px', cursor: 'pointer' },
      primary: { appearance: 'none', border: '1px solid transparent', background: '#4d6bfe', color: '#fff', borderRadius: '8px', padding: '6px 12px', fontSize: '13px', cursor: 'pointer' },
      quiet: { appearance: 'none', border: '1px solid transparent', background: 'transparent', color: 'inherit', opacity: 0.7, borderRadius: '8px', padding: '6px 8px', fontSize: '13px', cursor: 'pointer' },
      row: { display: 'grid', gridTemplateColumns: '1fr auto auto auto auto', gap: '10px', alignItems: 'center', padding: '6px 0', borderTop: '1px solid rgba(127,127,127,0.2)' },
      muted: { opacity: 0.7 },
      error: { color: '#e5484d' },
      pre: { margin: 0, padding: '10px', border: '1px solid rgba(127,127,127,0.3)', borderRadius: '8px', maxHeight: '220px', overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', whiteSpace: 'pre-wrap' },
      actions: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' },
    }

    /** Describe one RPC failure for display. */
    function describeFailure(error) {
      if (error === undefined || error === null) return 'unknown error'
      const code = typeof error.code === 'string' ? error.code : 'error'
      const message = typeof error.message === 'string' ? error.message : String(error)
      return `${code}: ${message}`
    }

    /** The first profile a user could switch to. */
    function firstCandidate(status) {
      const profile = (status?.profiles ?? []).find((entry) => entry.name !== status.activeName)
      return profile === undefined ? '' : profile.name
    }

    /**
     * One settings page: current profile, the profiles tree, and the two actions.
     * @param {{ t: Function, rpcCall: Function }} props - injected faces from the registration.
     */
    function ProfileBridgeSettings(props) {
      const t = props.t
      const call = props.rpcCall
      const [status, setStatus] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [failure, setFailure] = React.useState(null)
      const [receipt, setReceipt] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [selected, setSelected] = React.useState('')

      const load = React.useCallback(async () => {
        setLoading(true)
        setFailure(null)
        try {
          const result = await call('status', {})
          if (result?.ok === true) {
            setStatus(result.value)
            setSelected((current) => (current !== '' ? current : firstCandidate(result.value)))
          } else {
            setFailure(describeFailure(result?.error))
          }
        } catch (error) {
          setFailure(describeFailure({ code: 'transport', message: error?.message ?? String(error) }))
        } finally {
          setLoading(false)
        }
      }, [call])

      React.useEffect(() => {
        void load()
      }, [load])

      const run = React.useCallback(async (endpoint, payload) => {
        setBusy(endpoint)
        setFailure(null)
        try {
          const result = await call(endpoint, payload)
          if (result?.ok === true) setReceipt({ endpoint, value: result.value })
          else setFailure(describeFailure(result?.error))
        } catch (error) {
          setFailure(describeFailure({ code: 'transport', message: error?.message ?? String(error) }))
        } finally {
          setBusy('')
        }
      }, [call])

      const isDesktop = status?.appKind === 'desktop'
      const candidates = (status?.profiles ?? []).filter((profile) => profile.name !== status?.activeName)

      return h('section', { style: styles.page },
        h('h2', { style: styles.title }, t('title')),
        h('p', { style: styles.subtitle }, t('subtitle')),

        h('div', { style: styles.card },
          h('div', null,
            `${t('current')}: `,
            h('code', { style: styles.code }, status?.activeName ?? '—'),
            status?.activeIsLink === true
              ? ` ${t('linkedTo')} `
              : ` · ${t('independent')}`,
            status?.activeIsLink === true ? h('code', { style: styles.code }, status?.linkTargetName ?? '?') : null,
          ),
          h('div', { style: styles.muted },
            h('span', null, status?.activeDir ?? ''),
          ),
          isDesktop || status === null ? null : h('p', { style: { ...styles.muted, margin: 0 } }, t('cliHint')),
        ),

        h('div', { style: styles.card },
          h('strong', null, t('profiles')),
          candidates.length === 0
            ? h('span', { style: styles.muted }, t('noTargets'))
            : candidates.map((profile) => h('label', { key: profile.name, style: styles.row },
                h('span', { style: { display: 'grid' } },
                  h('span', null,
                    h('code', { style: styles.code }, profile.name),
                    profile.isLink ? h('span', { style: styles.muted }, ` → ${profile.linkTargetName}`) : null,
                  ),
                  h('span', { style: styles.muted }, profile.dir),
                ),
                h('span', { style: styles.muted }, `${t('deps')} ${profile.dependencyCount}`),
                h('span', { style: styles.muted }, `${t('bundles')} ${profile.bundleCount}`),
                h('span', { style: styles.muted }, profile.hasNodeModules ? 'node_modules ✓' : 'node_modules ✗'),
                h('input', {
                  type: 'radio',
                  name: 'profile-bridge-target',
                  checked: selected === profile.name,
                  onChange: () => setSelected(profile.name),
                  'aria-label': profile.name,
                }),
              )),
        ),

        h('div', { style: styles.actions },
          h('button', {
            type: 'button',
            style: { ...styles.primary, opacity: busy !== '' || selected === '' || isDesktop !== true ? 0.5 : 1 },
            disabled: busy !== '' || selected === '' || isDesktop !== true,
            onClick: () => void run('link', { target: selected }),
          }, busy === 'link' ? t('working') : t('use')),
          h('button', {
            type: 'button',
            style: { ...styles.button, opacity: busy !== '' || status?.activeIsLink !== true ? 0.5 : 1 },
            disabled: busy !== '' || status?.activeIsLink !== true,
            onClick: () => void run('unlink', {}),
          }, busy === 'unlink' ? t('working') : t('revert')),
          h('button', { type: 'button', style: styles.quiet, disabled: busy !== '', onClick: () => void load() }, t('refresh')),
          loading ? h('span', { style: styles.muted }, t('loading')) : null,
        ),

        receipt?.value?.warnings?.length > 0
          ? h('div', { style: styles.card },
              h('strong', null, t('warnings')),
              receipt.value.warnings.map((warning) => h('div', { key: warning, style: styles.muted }, `• ${warning}`)),
            )
          : null,

        receipt?.endpoint === 'link'
          ? h('p', { style: { margin: 0, opacity: 0.85 } }, `${t('closing')} (${receipt.value?.note ?? ''})`)
          : null,
        receipt?.endpoint === 'unlink'
          ? h('p', { style: { margin: 0, opacity: 0.85 } }, receipt.value?.note ?? '')
          : null,

        failure !== null ? h('p', { style: { ...styles.error, margin: 0 } }, `${t('failure')}: ${failure}`) : null,

        h('details', null,
          h('summary', { style: { cursor: 'pointer', opacity: 0.8 } }, t('log')),
          h('pre', { style: styles.pre }, status?.logTail && status.logTail !== '' ? status.logTail : t('logEmpty')),
        ),

        h('details', null,
          h('summary', { style: { cursor: 'pointer', opacity: 0.8 } }, t('how')),
          h('p', { style: { ...styles.muted, margin: '8px 0 0' } }, t('why')),
          h('p', { style: { ...styles.muted, margin: 0 } }, t('mustClose')),
        ),
      )
    }

    return {
      inject: ['slots', 'locale', 'connection'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        const rpcCall = (endpoint, payload) => ctx.connection.rpc.call(CHANNEL, endpoint, payload)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'profile-bridge: locale dictionaries')
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'profile-bridge',
          order: 60,
          label: () => t('section'),
          inject: () => ({ rpcCall, t }),
        }, ProfileBridgeSettings))
      },
    }
  },
})
