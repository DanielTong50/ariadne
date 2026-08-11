import * as vscode from 'vscode';
import { FdeDataStore } from './dataStore';
import { ContextEngine } from './contextEngine/contextEngine';
import { BackendManager } from './backends/backendManager';

/**
 * Bundle of everything a command or view needs. Passed explicitly rather than
 * pulled from globals so each command function stays testable in isolation
 * (construct a fake AppContext, call the function, assert on the fake store).
 */
export interface AppContext {
  context: vscode.ExtensionContext;
  store: FdeDataStore;
  engine: ContextEngine;
  backends: BackendManager;
  output: vscode.OutputChannel;
}
