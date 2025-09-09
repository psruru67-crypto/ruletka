import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider, WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import { PhantomWalletAdapter, SolflareWalletAdapter } from '@solana/wallet-adapter-wallets'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { Connection, LAMPORTS_PER_SOL, Transaction } from '@solana/web3.js'
import { Buffer } from 'buffer'
import '@solana/wallet-adapter-react-ui/styles.css'

const RPC_URL = import.meta.env.VITE_RPC_URL as string
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL as string
const PRICE_LAMPORTS = Number(import.meta.env.VITE_PRICE_LAMPORTS || 20_000_000) // 0.02 SOL

function InnerApp() {
  const { connection } = useConnection()
  const { publicKey, sendTransaction, connected } = useWallet()
  const [balance, setBalance] = useState<number | null>(null)
  const [status, setStatus] = useState<string>('')
  const [house, setHouse] = useState<string>('')

  const refresh = useCallback(async () => {
    if (publicKey) {
      const lamports = await connection.getBalance(publicKey)
      setBalance(lamports / LAMPORTS_PER_SOL)
    } else {
      setBalance(null)
    }
  }, [publicKey, connection])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${BACKEND_URL}/health`).then(r => r.json())
        if (r.ok) setHouse(r.house)
      } catch { /* ignore */ }
    })()
  }, [])

  const onSpin = useCallback(async () => {
    if (!connected || !publicKey) {
      setStatus('Connect wallet first')
      return
    }
    setStatus('Preparing bet...')

    const prep = await fetch(`${BACKEND_URL}/bet/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerPubkey: publicKey.toBase58() })
    }).then(r => r.json())

    if (!prep.txBase64) {
      setStatus('Failed to prepare: ' + JSON.stringify(prep))
      return
    }

    const tx = Transaction.from(Buffer.from(prep.txBase64, 'base64'))

    setStatus('Sending transaction...')
    const sig = await sendTransaction(tx, connection as Connection, { skipPreflight: false })
    await connection.confirmTransaction(
      { signature: sig, blockhash: prep.blockhash, lastValidBlockHeight: prep.lastValidBlockHeight },
      'confirmed'
    )

    setStatus('Settling...')
    const settled = await fetch(`${BACKEND_URL}/bet/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature: sig, playerPubkey: publicKey.toBase58() })
    }).then(r => r.json())

    if (settled.ok) {
      if (settled.win) {
        setStatus(`🎉 You WON! Payout tx: ${settled.payoutSignature}`)
      } else {
        setStatus('🙃 You lost. Try again!')
      }
      await refresh()
    } else {
      setStatus('Settle failed: ' + JSON.stringify(settled))
    }
  }, [connected, publicKey, sendTransaction, connection, refresh])

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'radial-gradient(circle at 30% 30%, #0b1220, #010409 70%)', color: '#e6edf3', fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica, Arial, Apple Color Emoji, Segoe UI Emoji' }}>
      <div style={{ width: 520, padding: 24, borderRadius: 16, background: 'rgba(255,255,255,0.03)', boxShadow: '0 8px 30px rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0 }}>Sol Roulette</h2>
          <WalletMultiButton />
        </div>
        <div style={{ fontSize: 14, opacity: 0.9, marginBottom: 12 }}>
          Network: <b>mainnet-beta</b><br/>
          Backend: <code>{BACKEND_URL}</code><br/>
          House: <code>{house || '...'}</code><br/>
          Price: <b>{PRICE_LAMPORTS / LAMPORTS_PER_SOL} SOL</b>
        </div>
        <div style={{ marginBottom: 12 }}>
          {publicKey ? (
            <div>Wallet: <code>{publicKey.toBase58()}</code></div>
          ) : (
            <div>Connect a wallet to play</div>
          )}
          <div>Balance: <b>{balance ?? '—'}</b> SOL</div>
        </div>
        <button onClick={onSpin} disabled={!connected} style={{ width: '100%', padding: 14, borderRadius: 12, border: '1px solid rgba(255,255,255,0.12)', background: connected ? '#1f6feb' : '#30363d', color: 'white', fontWeight: 600, cursor: connected ? 'pointer' : 'not-allowed' }}>
          Spin for {PRICE_LAMPORTS / LAMPORTS_PER_SOL} SOL
        </button>
        <div style={{ marginTop: 14, minHeight: 24, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13 }}>
          {status}
        </div>
        <p style={{ marginTop: 12, fontSize: 12, opacity: 0.7 }}>Note: Off-chain RNG & payouts by backend. No PDA vault.</p>
      </div>
    </div>
  )
}

export default function App() {
  const endpoint = RPC_URL
  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter(),
    ],
    []
  )

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <InnerApp />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  )
}
