import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Stack from '@mui/material/Stack';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Button from '@mui/material/Button';
import TuneIcon from '@mui/icons-material/TuneOutlined';

import useInquiryCounts from '../hooks/useInquiryCounts';
import NewBadge from '../components/common/NewBadge';
import PageHeader from '../components/common/PageHeader';
import ContactMessagesTab from '../components/inquiries/ContactMessagesTab';
import NewsletterTab from '../components/inquiries/NewsletterTab';
import CareerApplicationsTab from '../components/inquiries/CareerApplicationsTab';

const TABS = ['messages', 'newsletter', 'careers'];

/**
 * Everything the storefront's public forms produce, in one place: contact-us
 * enquiries, newsletter sign-ups and job applications.
 *
 * The active tab lives in the URL so an admin notification can deep-link straight to
 * "/inquiries?tab=careers" and a refresh keeps the reader where they were.
 */
export default function Inquiries() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = TABS.includes(searchParams.get('tab')) ? searchParams.get('tab') : 'messages';

  // Shared with the sidebar's Inquiries badge, so the three numbers always agree.
  const { counts, refresh } = useInquiryCounts();

  // The Careers tab's editor. It opens from the page header, where every other
  // screen in the panel keeps its page-level action, so the flag lives up here.
  const [setupOpen, setSetupOpen] = useState(false);

  const selectTab = (_event, value) => {
    setSearchParams(value === 'messages' ? {} : { tab: value }, { replace: true });
  };

  /**
   * A tab keeps its label's weight and spacing; the badge sits after it, and is
   * absent entirely when that tab has nothing new.
   */
  const tabLabel = (label, count) => (
    <Stack direction="row" alignItems="center" spacing={0.75} component="span">
      <span>{label}</span>
      <NewBadge count={count} />
    </Stack>
  );

  return (
    <Box>
      <PageHeader
        title="Inquiries"
        subtitle="Messages, newsletter sign-ups and job applications submitted through the website."
        breadcrumbs={[{ label: 'Inquiries' }]}
        action={
          tab === 'careers' ? (
            <Button variant="outlined" startIcon={<TuneIcon />} onClick={() => setSetupOpen(true)}>
              Positions &amp; HR contact
            </Button>
          ) : undefined
        }
      />

      <Card sx={{ mb: 2.5 }}>
        <Tabs value={tab} onChange={selectTab} variant="scrollable" scrollButtons="auto">
          <Tab
            value="messages"
            label={tabLabel('Contact Us', counts.messages)}
            sx={{ fontWeight: 700, py: 2 }}
          />
          <Tab value="newsletter" label="Newsletter Emails" sx={{ fontWeight: 700, py: 2 }} />
          <Tab
            value="careers"
            label={tabLabel('Careers', counts.careers)}
            sx={{ fontWeight: 700, py: 2 }}
          />
        </Tabs>
      </Card>

      {/* Unmounting the hidden tabs keeps their filters and polling out of the way.
          `onCountsChanged` fires when a tab marks a record read, so the badges here
          and in the sidebar drop the moment the row does. */}
      {tab === 'messages' && <ContactMessagesTab onCountsChanged={refresh} />}
      {tab === 'newsletter' && <NewsletterTab />}
      {tab === 'careers' && (
        <CareerApplicationsTab
          onCountsChanged={refresh}
          setupOpen={setupOpen}
          onSetupOpenChange={setSetupOpen}
        />
      )}
    </Box>
  );
}

