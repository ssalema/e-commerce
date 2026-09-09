import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSnackbar } from 'notistack';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid2';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Chip from '@mui/material/Chip';
import Skeleton from '@mui/material/Skeleton';
import CircularProgress from '@mui/material/CircularProgress';
import InputAdornment from '@mui/material/InputAdornment';

import SaveIcon from '@mui/icons-material/SaveOutlined';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import InstagramIcon from '@mui/icons-material/Instagram';
import XIcon from '@mui/icons-material/X';
import WhatsAppIcon from '@mui/icons-material/WhatsApp';
import FacebookIcon from '@mui/icons-material/FacebookOutlined';
import LinkedInIcon from '@mui/icons-material/LinkedIn';

import { settingApi } from '../api/endpoints';
import useFetch from '../hooks/useFetch';
import { useRealtimeEvent } from '../realtime/useRealtime';
import { EVENTS } from '../realtime/events';
import PageHeader from '../components/common/PageHeader';
import ErrorState from '../components/common/ErrorState';
import AssetPicker from '../components/common/AssetPicker';
import PhoneField from '../components/common/PhoneField';
import { phoneDigits } from '../utils/format';

const EMPTY = {
  general: { siteName: '', contactEmail: '', contactNumber: '', companyAddress: '', mapEmbedUrl: '' },
  // Held as strings like every other field here: the form is text inputs, and the
  // API coerces on the way in. Numbers would make an emptied box read as NaN.
  commerce: { freeShippingThreshold: '', shippingFlatRate: '', returnWindowDays: '' },
  seo: { metaTitle: '', metaDescription: '', metaKeywords: '' },
  branding: { logo: { url: '', publicId: '' }, favicon: { url: '', publicId: '' } },
  social: { instagram: '', twitter: '', whatsapp: '', facebook: '', linkedin: '' },
};

const asset = (value) => ({ url: value?.url || '', publicId: value?.publicId || '' });

/** Server document -> flat form state (keywords become the comma-separated string we show). */
function toForm(settings) {
  if (!settings) return EMPTY;
  return {
    general: {
      ...EMPTY.general,
      ...settings.general,
      // The number is edited in a +91 field and stored as bare digits, so anything
      // saved earlier with the code in the string is reduced on the way in.
      contactNumber: phoneDigits(settings.general?.contactNumber),
    },
    seo: {
      metaTitle: settings.seo?.metaTitle || '',
      metaDescription: settings.seo?.metaDescription || '',
      metaKeywords: (settings.seo?.metaKeywords || []).join(', '),
    },
    commerce: {
      // `?? ''` rather than `|| ''`: zero is a real setting here — "never free
      // delivery", "returns switched off" — and must not read as an empty box.
      freeShippingThreshold: String(settings.commerce?.freeShippingThreshold ?? ''),
      shippingFlatRate: String(settings.commerce?.shippingFlatRate ?? ''),
      returnWindowDays: String(settings.commerce?.returnWindowDays ?? ''),
    },
    branding: { logo: asset(settings.branding?.logo), favicon: asset(settings.branding?.favicon) },
    social: { ...EMPTY.social, ...settings.social },
  };
}

/**
 * Named once because the page renders its header three times — skeleton, error and
 * the form itself — and the three have to be the same height or the header jumps
 * as the fetch resolves.
 */
const SETTINGS_SUBTITLE =
  'Store identity, contact details, delivery and return rules, branding and search engine metadata — everything the storefront reads from here';

const SECTION_LABEL = {
  general: 'General information',
  commerce: 'Commerce rules',
  seo: 'SEO settings',
  branding: 'Branding',
  social: 'Social profiles',
};

/** Card shell shared by every section: title, per-section reset, consistent padding. */
/** A section card's outline: its heading, the divider, and `fields` inputs under it. */
function SectionSkeleton({ fields, columns = 1 }) {
  return (
    <Card sx={{ height: '100%' }}>
      <CardContent sx={{ p: { xs: 2, sm: 2.5 } }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
          <Skeleton variant="text" width={170} height={28} />
          <Skeleton variant="circular" width={28} height={28} />
        </Stack>

        <Divider sx={{ mt: 1.5, mb: 2.5 }} />

        <Grid container spacing={2.5}>
          {Array.from({ length: fields }).map((_, index) => (
            <Grid key={index} size={columns === 1 ? 12 : { xs: 12, md: 6, lg: 4 }}>
              <Skeleton variant="text" width={120} height={18} />
              <Skeleton variant="rounded" height={40} sx={{ mt: 1 }} />
            </Grid>
          ))}
        </Grid>
      </CardContent>
    </Card>
  );
}

/**
 * The whole settings page while its one document is being read.
 *
 * The form used to render straight away over an empty draft, with a progress bar on
 * top: every field showed as blank and then filled itself in, which reads as "there
 * is nothing saved here" for as long as the fetch takes. Drawing the sections instead
 * says the values are still coming, and none of them can be typed over mid-flight.
 */
function SettingsSkeleton() {
  return (
    <Box sx={{ pb: 10 }}>
      <PageHeader
        title="Settings"
        subtitle={SETTINGS_SUBTITLE}
        breadcrumbs={[{ label: 'Settings' }]}
      />

      <Grid container spacing={2.5} alignItems="stretch">
        <Grid size={{ xs: 12, lg: 5 }}>
          <SectionSkeleton fields={5} />
        </Grid>
        <Grid size={{ xs: 12, lg: 4 }}>
          <SectionSkeleton fields={3} />
        </Grid>
        <Grid size={{ xs: 12, lg: 3 }}>
          <SectionSkeleton fields={2} />
        </Grid>
        <Grid size={12}>
          <SectionSkeleton fields={3} columns={3} />
        </Grid>
        <Grid size={12}>
          <SectionSkeleton fields={5} columns={3} />
        </Grid>
      </Grid>
    </Box>
  );
}

function SectionCard({ title, section, onReset, dirty, children }) {
  return (
    <Card sx={{ height: '100%' }}>
      <CardContent sx={{ p: { xs: 2, sm: 2.5 } }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
          <Typography variant="h6">{title}</Typography>
          <Stack direction="row" alignItems="center" spacing={1}>
            {dirty && <Chip label="Edited" size="small" color="warning" />}
            <Tooltip title={dirty ? `Undo changes to ${SECTION_LABEL[section].toLowerCase()}` : 'No changes to undo'}>
              <span>
                <IconButton size="small" disabled={!dirty} onClick={() => onReset(section)}>
                  <RestartAltIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
        </Stack>

        <Divider sx={{ mt: 1.5, mb: 2.5 }} />
        {children}
      </CardContent>
    </Card>
  );
}

/**
 * One labelled input with its own "last updated" stamp, so the admin can see at a
 * glance which details have gone stale.
 *
 * `control` swaps the input without giving up that header — the phone row uses
 * PhoneField so it carries the same locked +91 as every other number on the platform.
 */
function SettingField({
  label,
  path,
  values,
  errors,
  history,
  onChange,
  helperText,
  control: Control = TextField,
  ...textFieldProps
}) {
  const [section, field] = path.split('.');
  const updatedAt = history?.[path];

  return (
    <Box>
      <Stack direction="row" alignItems="baseline" justifyContent="space-between" spacing={1} sx={{ mb: 0.75 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          {label}
        </Typography>
        <Typography variant="caption" color="text.disabled" noWrap>
          {updatedAt ? `Last updated: ${new Date(updatedAt).toLocaleDateString('en-IN')}` : 'Never updated'}
        </Typography>
      </Stack>

      <Control
        fullWidth
        value={values[section][field]}
        onChange={(e) => onChange(section, field, e.target.value)}
        error={Boolean(errors[path])}
        {...textFieldProps}
        helperText={errors[path] || helperText}
      />
    </Box>
  );
}

export default function Settings() {
  const { enqueueSnackbar } = useSnackbar();
  const query = useFetch(useCallback(() => settingApi.get(), []), []);

  const [values, setValues] = useState(EMPTY);
  const [saved, setSaved] = useState(EMPTY); // last persisted snapshot, for dirty checks + undo
  const [history, setHistory] = useState({});
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  /** Seed the form once the document arrives (and after every successful save). */
  const adopt = useCallback((settings) => {
    const form = toForm(settings);
    setValues(form);
    setSaved(form);
    setHistory(settings?.fieldHistory || {});
  }, []);

  useEffect(() => {
    if (query.data) adopt(query.data.data.settings);
  }, [query.data, adopt]);

  const set = (section, field, value) => {
    setValues((v) => ({ ...v, [section]: { ...v[section], [field]: value } }));
    setErrors((e) => ({ ...e, [`${section}.${field}`]: undefined }));
  };

  const dirtySections = useMemo(
    () =>
      Object.keys(EMPTY).filter(
        (section) => JSON.stringify(values[section]) !== JSON.stringify(saved[section])
      ),
    [values, saved]
  );
  const isDirty = dirtySections.length > 0;

  // A half-finished settings change is easy to lose on a stray tab close.
  useEffect(() => {
    if (!isDirty) return undefined;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [isDirty]);

  /**
   * Adopt another admin's save — but never over a half-typed form. While this one is
   * dirty the incoming values are ignored, so the editor keeps their work and the
   * next save is theirs.
   */
  useRealtimeEvent(EVENTS.SETTINGS_UPDATED, (payload) => {
    if (isDirty || !payload?.settings) return;
    adopt(payload.settings);
  });

  const resetSection = (section) => {
    setValues((v) => ({ ...v, [section]: saved[section] }));
    setErrors({});
  };

  const save = async () => {
    setSaving(true);
    setErrors({});
    try {
      // The whole document goes up; the API stamps only the leaves that actually changed.
      const res = await settingApi.update(values);
      adopt(res.data.settings);
      enqueueSnackbar('Settings saved', { variant: 'success' });
    } catch (err) {
      const fieldErrors = {};
      (err.errors || []).forEach(({ field, message }) => {
        fieldErrors[field] = message;
      });
      setErrors(fieldErrors);
      enqueueSnackbar(err.message || 'Could not save the settings', { variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const fieldProps = { values, errors, history, onChange: set };

  if (query.loading) return <SettingsSkeleton />;
  if (query.error) {
    return (
      <Box>
        {/* The subtitle stays even though there is nothing to configure yet: the
            skeleton and the loaded page both carry one, and dropping it here is
            the difference between a header that holds still and one that shrinks
            the moment a fetch fails. */}
        <PageHeader
          title="Settings"
          subtitle={SETTINGS_SUBTITLE}
          breadcrumbs={[{ label: 'Settings' }]}
        />
        <Card>
          <ErrorState
            title="Could not load the settings"
            message={query.error.message}
            onRetry={query.refetch}
          />
        </Card>
      </Box>
    );
  }

  return (
    <Box sx={{ pb: 10 }}>
      <PageHeader
        title="Settings"
        subtitle={SETTINGS_SUBTITLE}
        breadcrumbs={[{ label: 'Settings' }]}
        action={
          isDirty ? <Chip label={`${dirtySections.length} section(s) edited`} color="warning" /> : null
        }
      />

      <Grid container spacing={2.5} alignItems="stretch">
        {/* ---------- General information ---------- */}
        <Grid size={{ xs: 12, lg: 5 }}>
          <SectionCard
            title="General Information"
            section="general"
            dirty={dirtySections.includes('general')}
            onReset={resetSection}
          >
            <Stack spacing={2.5}>
              <SettingField
                label="Site Name"
                path="general.siteName"
                placeholder="Your store name"
                inputProps={{ maxLength: 80 }}
                {...fieldProps}
              />
              <SettingField
                label="Contact Email"
                path="general.contactEmail"
                type="email"
                placeholder="support@yourstore.in"
                inputProps={{ maxLength: 120 }}
                {...fieldProps}
              />
              <SettingField
                label="Contact Number"
                path="general.contactNumber"
                control={PhoneField}
                placeholder="9000000000"
                {...fieldProps}
              />
              <SettingField
                label="Company Address"
                path="general.companyAddress"
                placeholder="City, State (Country)"
                multiline
                minRows={3}
                inputProps={{ maxLength: 300 }}
                {...fieldProps}
              />
              <SettingField
                label="Google Maps Embed"
                path="general.mapEmbedUrl"
                placeholder="https://www.google.com/maps/embed?pb=..."
                multiline
                minRows={3}
                inputProps={{ maxLength: 2000 }}
                helperText="Paste the embed link, or the whole <iframe> from Google Maps → Share → Embed a map. Drives the map on Contact Us and the footer's location link."
                {...fieldProps}
              />
            </Stack>
          </SectionCard>
        </Grid>

        {/* ---------- SEO ---------- */}
        <Grid size={{ xs: 12, lg: 4 }}>
          <SectionCard
            title="SEO Settings"
            section="seo"
            dirty={dirtySections.includes('seo')}
            onReset={resetSection}
          >
            <Stack spacing={2.5}>
              <SettingField
                label="Meta Title"
                path="seo.metaTitle"
                placeholder="Store | Your tagline"
                inputProps={{ maxLength: 70 }}
                helperText={`${values.seo.metaTitle.length}/70 characters — Google truncates beyond this`}
                {...fieldProps}
              />
              <SettingField
                label="Meta Description"
                path="seo.metaDescription"
                placeholder="One or two sentences describing the store"
                multiline
                minRows={3}
                inputProps={{ maxLength: 200 }}
                helperText={`${values.seo.metaDescription.length}/200 characters`}
                {...fieldProps}
              />
              <SettingField
                label="Meta Keywords"
                path="seo.metaKeywords"
                placeholder="springs, compression springs, industrial springs mumbai"
                multiline
                minRows={2}
                helperText="Separate each keyword with a comma"
                {...fieldProps}
              />
            </Stack>
          </SectionCard>
        </Grid>

        {/* ---------- Branding ---------- */}
        <Grid size={{ xs: 12, lg: 3 }}>
          <SectionCard
            title="Branding"
            section="branding"
            dirty={dirtySections.includes('branding')}
            onReset={resetSection}
          >
            <Stack spacing={3}>
              <AssetPicker
                label="Logo"
                hint="Transparent PNG, around 400×120px"
                ratio="16/9"
                value={values.branding.logo}
                onChange={(image) => set('branding', 'logo', asset(image))}
              />
              <AssetPicker
                label="Favicon"
                hint="Square PNG, 64×64px or larger"
                value={values.branding.favicon}
                onChange={(image) => set('branding', 'favicon', asset(image))}
              />
            </Stack>
          </SectionCard>
        </Grid>

        {/* ---------- Commerce rules ---------- */}
        <Grid size={12}>
          <SectionCard
            title="Commerce Rules"
            section="commerce"
            dirty={dirtySections.includes('commerce')}
            onReset={resetSection}
          >
            <Grid container spacing={2.5}>
              <Grid size={{ xs: 12, md: 6, lg: 4 }}>
                <SettingField
                  label="Free Delivery Above"
                  path="commerce.freeShippingThreshold"
                  type="number"
                  placeholder="499"
                  inputProps={{ min: 0, max: 1000000 }}
                  InputProps={{ startAdornment: <InputAdornment position="start">₹</InputAdornment> }}
                  helperText="Orders at or above this amount (after discounts and any coupon) ship free. Set 0 to make every order free."
                  {...fieldProps}
                />
              </Grid>
              <Grid size={{ xs: 12, md: 6, lg: 4 }}>
                <SettingField
                  label="Shipping Charge"
                  path="commerce.shippingFlatRate"
                  type="number"
                  placeholder="49"
                  inputProps={{ min: 0, max: 100000 }}
                  InputProps={{ startAdornment: <InputAdornment position="start">₹</InputAdornment> }}
                  helperText="Flat charge per order below the threshold, however many items it contains."
                  {...fieldProps}
                />
              </Grid>
              <Grid size={{ xs: 12, md: 6, lg: 4 }}>
                <SettingField
                  label="Return Threshold"
                  path="commerce.returnWindowDays"
                  type="number"
                  placeholder="7"
                  inputProps={{ min: 0, max: 365 }}
                  InputProps={{ endAdornment: <InputAdornment position="end">days</InputAdornment> }}
                  helperText="How long after delivery a customer may raise a return. The storefront hides the Return button outside this window and the API refuses it. Set 0 to switch returns off."
                  {...fieldProps}
                />
              </Grid>
            </Grid>
          </SectionCard>
        </Grid>

        {/* ---------- Social ---------- */}
        <Grid size={12}>
          <SectionCard
            title="Social Profiles"
            section="social"
            dirty={dirtySections.includes('social')}
            onReset={resetSection}
          >
            <Grid container spacing={2.5}>
              {[
                { field: 'instagram', label: 'Instagram', icon: <InstagramIcon fontSize="small" />, placeholder: 'https://instagram.com/yourstore' },
                { field: 'twitter', label: 'Twitter (X)', icon: <XIcon fontSize="small" />, placeholder: 'https://x.com/yourstore' },
                { field: 'whatsapp', label: 'WhatsApp', icon: <WhatsAppIcon fontSize="small" />, placeholder: '+91 90000 00000' },
                { field: 'facebook', label: 'Facebook', icon: <FacebookIcon fontSize="small" />, placeholder: 'https://facebook.com/yourstore' },
                { field: 'linkedin', label: 'LinkedIn', icon: <LinkedInIcon fontSize="small" />, placeholder: 'https://linkedin.com/company/yourstore' },
              ].map((network) => (
                <Grid key={network.field} size={{ xs: 12, md: 6, lg: 4 }}>
                  <SettingField
                    label={network.label}
                    path={`social.${network.field}`}
                    placeholder={network.placeholder}
                    InputProps={{
                      startAdornment: (
                        <InputAdornment position="start" sx={{ color: 'text.disabled' }}>
                          {network.icon}
                        </InputAdornment>
                      ),
                    }}
                    inputProps={{ maxLength: 200 }}
                    {...fieldProps}
                  />
                </Grid>
              ))}
            </Grid>
          </SectionCard>
        </Grid>
      </Grid>

      {/* ---------- Action bar ---------- */}
      <Box
        sx={{
          position: 'sticky',
          bottom: 0,
          mt: 2.5,
          py: 2,
          px: { xs: 2, sm: 2.5 },
          borderTop: 1,
          borderColor: 'divider',
          bgcolor: 'background.paper',
          borderRadius: '12px 12px 0 0',
          boxShadow: '0 -1px 3px rgba(15,23,42,.06)',
        }}
      >
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1.5}
          alignItems={{ xs: 'stretch', sm: 'center' }}
          justifyContent="space-between"
        >
          <Typography variant="body2" color="text.secondary">
            {isDirty
              ? 'You have unsaved changes.'
              : 'Everything here is live on the storefront.'}
          </Typography>

          <Stack direction="row" spacing={1.5} justifyContent="flex-end">
            <Button
              color="inherit"
              disabled={!isDirty || saving}
              startIcon={<RestartAltIcon />}
              onClick={() => {
                setValues(saved);
                setErrors({});
              }}
            >
              Discard
            </Button>
            <Button
              variant="contained"
              disabled={!isDirty || saving}
              onClick={save}
              startIcon={saving ? <CircularProgress size={15} color="inherit" /> : <SaveIcon />}
            >
              Save changes
            </Button>
          </Stack>
        </Stack>
      </Box>
    </Box>
  );
}
