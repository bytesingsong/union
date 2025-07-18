<script lang="ts">
import SharpChevronLeftIcon from "$lib/components/icons/SharpChevronLeftIcon.svelte"
import { chains } from "$lib/stores/chains.svelte.ts"
import { tokensStore } from "$lib/stores/tokens.svelte.ts"
import AssetSelector from "$lib/transfer/shared/components/ChainAsset/AssetSelector.svelte"
import ChainAssetButton from "$lib/transfer/shared/components/ChainAsset/ChainAssetButton.svelte"
import ChainSelector from "$lib/transfer/shared/components/ChainAsset/ChainSelector.svelte"
import { clickOutside } from "$lib/utils/actions.ts"
import { Option } from "effect"
import { onDestroy, onMount } from "svelte"
import { crossfade, fade, fly } from "svelte/transition"

type Props = {
  type: "source" | "destination"
  isOpen?: (b: boolean) => void
}
let { type, isOpen }: Props = $props()

let open = $state(false)
let page: 1 | 2 = $state(1)
let previousPage: 1 | 2 = $state(1)

function back() {
  if (page === 2) {
    previousPage = page
    page = 1
  } else {
    open = false
    isOpen?.(false)
  }
}

function onChainSelected() {
  if (type === "destination") {
    open = false
  } else {
    previousPage = page
    page = 2
  }
}

function onAssetSelected() {
  previousPage = page
  page = 1
  open = false
  isOpen?.(false)
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && open) {
    open = false
    isOpen?.(false)
  }
}

onMount(() => {
  document.addEventListener("keydown", handleKeydown)
})

onDestroy(() => {
  document.removeEventListener("keydown", handleKeydown)
})

const [send, receive] = crossfade({
  duration: 200,
  fallback(node) {
    return fly(node, { delay: 0, duration: 200, y: 20 })
  },
})

$effect(() => {
  if (Option.isSome(chains.data)) {
    for (const chain of chains.data.value) {
      tokensStore.fetchTokens(chain.universal_chain_id)
    }
  }
})

function handleClick() {
  open = true
  isOpen?.(true)
}
</script>
{#if open}
  <div
    class="absolute inset-0 bg-zinc-925 z-40 flex"
    transition:fade={{ duration: 300 }}
  >
    <div
      class="w-full h-full flex flex-col"
      transition:fly={{ y: 30, duration: 300, opacity: 0 }}
    >
      <!-- Header with close button -->
      <div class="p-4 border-b border-zinc-800 flex justify-between items-center h-12 flex-shrink-0">
        <button
          aria-label="Back"
          onclick={back}
          class="mr-3 flex items-center text-zinc-400 hover:text-zinc-200 cursor-pointer h-full"
        >
          <SharpChevronLeftIcon class="size-6" />
          <div class="ml-2 flex items-center">
            <span class="text-lg text-zinc-100">Select</span>
            <div class="relative w-16 h-6 flex items-center ml-2">
              {#if page === 1}
                <span
                  class="text-lg text-zinc-100 absolute"
                  in:receive={{ key: "chain" }}
                  out:send={{ key: "chain" }}
                >
                  Chain
                </span>
              {:else}
                <span
                  class="text-lg text-zinc-100 absolute"
                  in:receive={{ key: "asset" }}
                  out:send={{ key: "asset" }}
                >
                  Asset
                </span>
              {/if}
            </div>
          </div>
        </button>
      </div>

      <!-- Modal Content with transitions -->
      <div class="flex-grow relative overflow-hidden">
        <!-- These divs take up all available height but don't add their own scrolling -->
        {#if page === 1}
          <div
            class="absolute inset-0"
            in:fly={{ x: previousPage > page ? -20 : 20, duration: 300, opacity: 0 }}
            out:fly={{ x: previousPage > page ? 20 : -20, duration: 300, opacity: 0 }}
            use:clickOutside
            onClickOutside={() => back()}
          >
            <ChainSelector
              {type}
              onSelect={onChainSelected}
            />
          </div>
        {:else if page === 2}
          <div
            class="absolute inset-0 h-full"
            in:fly={{ x: previousPage > page ? -20 : 20, duration: 300, opacity: 0 }}
            out:fly={{ x: previousPage > page ? 20 : -20, duration: 300, opacity: 0 }}
            use:clickOutside
            onClickOutside={() => back()}
          >
            {#if type === "source"}
              <AssetSelector onSelect={onAssetSelected} />
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}
<!-- Chain Asset Button -->
<ChainAssetButton
  {type}
  onClick={handleClick}
/>
