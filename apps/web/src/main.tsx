import '@fontsource-variable/inter'
import './styles/global.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { TooltipProvider } from '@radix-ui/react-tooltip'
import { App } from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <TooltipProvider delayDuration={500} skipDelayDuration={200}>
        <App />
      </TooltipProvider>
    </BrowserRouter>
  </React.StrictMode>,
)
