/**
 * Selector storage for indexed Angular elements. Pure lookup structure with no
 * editor or file-system dependencies.
 * @module
 */

import * as path from "node:path";
import type { AngularElementData } from "../types";

/**
 * Represents a node in a Trie data structure for storing selectors.
 * @internal
 */
class TrieNode {
  public children: Map<string, TrieNode> = new Map();
  public elements: AngularElementData[] = [];
}

/**
 * A Trie-based data structure for efficient searching of Angular selectors.
 */
export class SelectorTrie {
  private root: TrieNode = new TrieNode();

  public insert(selector: string, elementData: AngularElementData): void {
    let currentNode = this.root;
    for (const char of selector) {
      if (!currentNode.children.has(char)) {
        currentNode.children.set(char, new TrieNode());
      }
      const nextNode = currentNode.children.get(char);
      if (!nextNode) {
        throw new Error("Unexpected missing node in trie insertion");
      }
      currentNode = nextNode;
    }
    // Avoid adding duplicate elements for the same selector
    if (!currentNode.elements.some((el) => el.name === elementData.name && el.path === elementData.path)) {
      currentNode.elements.push(elementData);
    }
  }

  public searchWithSelectors(prefix: string): { selector: string; element: AngularElementData }[] {
    let currentNode = this.root;
    for (const char of prefix) {
      if (!currentNode.children.has(char)) {
        return [];
      }
      const nextNode = currentNode.children.get(char);
      if (!nextNode) {
        return [];
      }
      currentNode = nextNode;
    }
    // We found the node for the prefix. Now collect everything underneath it.
    // The collector needs the prefix to build the full selectors.
    return this.collectAllElementsWithSelectors(currentNode, prefix);
  }

  public findAll(selector: string): AngularElementData[] {
    let currentNode = this.root;
    for (const char of selector) {
      if (!currentNode.children.has(char)) {
        return [];
      }
      const nextNode = currentNode.children.get(char);
      if (!nextNode) {
        return [];
      }
      currentNode = nextNode;
    }
    return currentNode.elements;
  }

  public getAllSelectors(): string[] {
    const selectors: string[] = [];
    this.collectSelectors(this.root, "", selectors);
    return selectors;
  }

  private collectSelectors(node: TrieNode, prefix: string, selectors: string[]): void {
    if (node.elements.length > 0) {
      selectors.push(prefix);
    }
    for (const [char, childNode] of node.children.entries()) {
      this.collectSelectors(childNode, prefix + char, selectors);
    }
  }

  public remove(selector: string, elementPath: string, elementName?: string): void {
    let currentNode = this.root;
    for (const char of selector) {
      if (!currentNode.children.has(char)) {
        return; // Selector doesn't exist
      }
      const nextNode = currentNode.children.get(char);
      if (!nextNode) {
        return; // Selector doesn't exist
      }
      currentNode = nextNode;
    }
    // Remove the element if it matches the path and optionally the name
    currentNode.elements = currentNode.elements.filter((el) => {
      const isPathMatch = path.resolve(el.path) === path.resolve(elementPath);
      if (!isPathMatch) {
        return true; // Path doesn't match, keep it.
      }
      // Path matches. If elementName is provided, we must also match its name to remove.
      if (elementName) {
        return el.name !== elementName; // Keep if name is different.
      }
      // Path matches and no name provided, means we remove all elements from this path for the given selector.
      return false;
    });
  }

  public getAllElements(): AngularElementData[] {
    return this.collectAllElements(this.root);
  }

  private collectAllElements(node: TrieNode): AngularElementData[] {
    let results: AngularElementData[] = [...node.elements];
    for (const childNode of node.children.values()) {
      results = results.concat(this.collectAllElements(childNode));
    }
    return results;
  }

  private collectAllElementsWithSelectors(
    node: TrieNode,
    currentSelector: string
  ): { selector: string; element: AngularElementData }[] {
    const results: { selector: string; element: AngularElementData }[] = [];

    if (node.elements.length > 0) {
      for (const element of node.elements) {
        results.push({ selector: currentSelector, element });
      }
    }

    for (const [char, childNode] of node.children.entries()) {
      results.push(...this.collectAllElementsWithSelectors(childNode, currentSelector + char));
    }

    return results;
  }

  public clear(): void {
    this.root = new TrieNode();
  }

  public get size(): number {
    return this.getAllSelectors().length;
  }
}
