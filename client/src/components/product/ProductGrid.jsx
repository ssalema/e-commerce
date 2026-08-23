import { useTranslation } from 'react-i18next';
import ProductCard from './ProductCard';
import { ProductGridSkeleton } from '../common/Skeleton';
import { PRODUCT_GRID_COLUMNS } from '../../utils/constants';
import EmptyState from '../common/EmptyState';

export default function ProductGrid({
  products = [],
  loading = false,
  skeletonCount = 10,
  emptyTitle,
  emptyMessage,
  emptyAction,
  columns = PRODUCT_GRID_COLUMNS.full,
}) {
  const { t } = useTranslation('shop');

  if (loading) return <ProductGridSkeleton count={skeletonCount} columns={columns} />;

  if (!products.length) {
    return (
      <EmptyState
        title={emptyTitle || t('grid.emptyTitle')}
        message={emptyMessage || t('grid.emptyMessage')}
        actionLabel={emptyAction?.label}
        actionTo={emptyAction?.to}
        onAction={emptyAction?.onClick}
      />
    );
  }

  return (
    <div className={`grid gap-4 ${columns}`}>
      {products.map((product) => (
        <ProductCard key={product._id} product={product} />
      ))}
    </div>
  );
}
