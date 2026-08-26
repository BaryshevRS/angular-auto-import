/**
 * Selector storage for indexed Angular elements. Pure lookup structure with no
 * editor or file-system dependencies.
 * @module
 */

import * as path from "node:path";
import type { AngularElementData } from "../types";

/**
 * Names one indexed element among all of them.
 *
 * Not name and import path: an element reached through an NgModule is indexed under that
 * module's name and entry point, which every element the module exports shares. The
 * selector is what separates them.
 *
 * The file it is declared in is deliberately not part of this: an element read again
 * after its declaring file moved is the same element, and has to replace the reading
 * that named the old file rather than sit beside it.
 * @param element The indexed element.
 */
export function elementIdentityKey(element: { name: string; path: string; originalSelector: string }): string {
  return [element.name, element.path, element.originalSelector].join(" | ");
}

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

    // One element per identity, and the newest reading of it wins: a re-indexed element
    // is the same element with fresher facts — the file it is declared in may have moved
    // — and keeping the first reading would leave the index describing a file that is
    // no longer there.
    const key = elementIdentityKey(elementData);
    const existing = currentNode.elements.findIndex((el) => elementIdentityKey(el) === key);
    if (existing === -1) {
      currentNode.elements.push(elementData);
    } else {
      currentNode.elements[existing] = elementData;
    }
  }

  /**
   * Removes one element from every selector it answers to.
   * @param elementData The element to remove.
   */
  public removeElement(elementData: AngularElementData): void {
    const key = elementIdentityKey(elementData);
    for (const selector of elementData.selectors) {
      let currentNode = this.root;
      let found = true;
      for (const char of selector) {
        const nextNode = currentNode.children.get(char);
        if (!nextNode) {
          found = false;
          break;
        }
        currentNode = nextNode;
      }
      if (found) {
        currentNode.elements = currentNode.elements.filter((el) => elementIdentityKey(el) !== key);
      }
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

  /**
   * Removes the element a file contributed under one selector, whatever it is indexed as.
   *
   * {@link remove} matches on the path an element is *imported* from, which for an element
   * reached through an NgModule is the module's, not the file that declares it — so a file
   * being re-read cannot retract what it contributed by its own path and class name. The
   * declaring file is recorded on the element itself, and identifies it exactly.
   * @param selector The selector to remove under.
   * @param absolutePath Absolute path of the file that declared the element.
   */
  public removeDeclaredIn(selector: string, absolutePath: string): void {
    let currentNode = this.root;
    for (const char of selector) {
      const nextNode = currentNode.children.get(char);
      if (!nextNode) {
        return; // Selector doesn't exist
      }
      currentNode = nextNode;
    }

    const target = path.resolve(absolutePath);
    currentNode.elements = currentNode.elements.filter(
      (el) => !el.absolutePath || path.resolve(el.absolutePath) !== target
    );
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
