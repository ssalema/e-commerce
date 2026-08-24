import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { wishlistApi } from '../api/endpoints';

export const fetchWishlist = createAsyncThunk('wishlist/fetch', async (_, { rejectWithValue }) => {
  try {
    const res = await wishlistApi.get();
    return res.data.wishlist;
  } catch (err) {
    return rejectWithValue(err);
  }
});

/**
 * <App> asks for these once the session resolves and <RealtimeProvider> asks again
 * the moment the socket connects — both within the same tick of a signed-in boot,
 * which was two identical requests on every authenticated page view. Concurrent
 * callers share one request; a later reconnect, with nothing in flight, still
 * refetches exactly as before. See the matching note in cartSlice.
 */
let idsInFlight = null;
export const fetchWishlistIds = createAsyncThunk('wishlist/ids', async (_, { rejectWithValue }) => {
  try {
    idsInFlight = idsInFlight || wishlistApi.ids().finally(() => { idsInFlight = null; });
    const res = await idsInFlight;
    return res.data.ids;
  } catch (err) {
    return rejectWithValue(err);
  }
});

/**
 * Optimistic toggle: the heart flips immediately and rolls back only if the
 * request fails, so the card never feels laggy.
 */
export const toggleWishlist = createAsyncThunk(
  'wishlist/toggle',
  async (arg, { getState, dispatch, rejectWithValue }) => {
    // Accepts a bare id (every existing caller) or `{ productId, variantId }` from a page
    // where the shopper has an option selected.
    const { productId, variantId } = typeof arg === 'string' ? { productId: arg } : arg;

    const wasWishlisted = getState().wishlist.ids.includes(productId);
    dispatch(wishlistSlice.actions.optimisticToggle(productId));

    try {
      if (wasWishlisted) await wishlistApi.remove(productId);
      else await wishlistApi.add(productId, variantId);
      return { productId, added: !wasWishlisted };
    } catch (err) {
      dispatch(wishlistSlice.actions.optimisticToggle(productId));
      return rejectWithValue(err);
    }
  }
);

const wishlistSlice = createSlice({
  name: 'wishlist',
  initialState: { items: [], ids: [], loading: false, error: null },
  reducers: {
    optimisticToggle: (state, action) => {
      const id = action.payload;
      state.ids = state.ids.includes(id) ? state.ids.filter((x) => x !== id) : [...state.ids, id];
    },
    resetWishlist: (state) => {
      state.items = [];
      state.ids = [];
    },
    /** A wishlist pushed over the socket after another tab or device changed it. */
    wishlistReceived: (state, action) => {
      const wishlist = action.payload;
      if (!wishlist) return;
      state.items = wishlist.items || [];
      state.ids = (wishlist.items || []).map((i) => i.product._id);
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchWishlist.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchWishlist.fulfilled, (state, action) => {
        state.loading = false;
        state.error = null;
        state.items = action.payload.items || [];
        state.ids = (action.payload.items || []).map((i) => i.product._id);
      })
      // Without this the page cannot tell a failed load from a genuinely empty
      // wishlist, and renders the empty state over a network error.
      .addCase(fetchWishlist.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload?.message || null;
      })
      .addCase(fetchWishlistIds.fulfilled, (state, action) => {
        state.ids = action.payload || [];
      })
      .addCase(toggleWishlist.fulfilled, (state, action) => {
        // Keep the detailed list in sync when an item is removed from the wishlist page.
        if (!action.payload.added) {
          state.items = state.items.filter((i) => i.product._id !== action.payload.productId);
        }
      });
  },
});

export const { resetWishlist, wishlistReceived } = wishlistSlice.actions;
export default wishlistSlice.reducer;
