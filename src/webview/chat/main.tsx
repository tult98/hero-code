import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Chat } from './Chat.js'

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Chat />
    </StrictMode>,
  )
}
