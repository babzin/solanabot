import { EventEmitter } from 'events';

export const terminalEvents = new EventEmitter();
terminalEvents.setMaxListeners(100);

export enum TerminalEventType {
  NEW_TRENDING = 'NEW_TRENDING',
  PRICE_PUMP = 'PRICE_PUMP',
  PRICE_DIP = 'PRICE_DIP',
  TRADE_EXECUTED = 'TRADE_EXECUTED',
}

export function broadcastNewTrending(candidate: any): void {
  terminalEvents.emit(TerminalEventType.NEW_TRENDING, candidate);
}

export function broadcastPricePump(pumpData: any): void {
  terminalEvents.emit(TerminalEventType.PRICE_PUMP, pumpData);
}

export function broadcastPriceDip(dipData: any): void {
  terminalEvents.emit(TerminalEventType.PRICE_DIP, dipData);
}

export function broadcastTrade(tradeData: any): void {
  terminalEvents.emit(TerminalEventType.TRADE_EXECUTED, tradeData);
}
