'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import type { Contact, Tag, ContactTag } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Search,
  Plus,
  Upload,
  MoreHorizontal,
  Pencil,
  Trash2,
  Loader2,
  Users,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { ContactForm } from '@/components/contacts/contact-form';
import { ContactDetailView } from '@/components/contacts/contact-detail-view';
import { ImportModal } from '@/components/contacts/import-modal';

const PAGE_SIZE = 25;

interface ContactWithTags extends Contact {
  tags?: Tag[];
}

export default function ContactsPage() {
  const supabase = createClient();

  const [contacts, setContacts] = useState<ContactWithTags[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);

  // Modals
  const [formOpen, setFormOpen] = useState(false);
  const [editContact, setEditContact] = useState<Contact | null>(null);
  const [editContactTags, setEditContactTags] = useState<ContactTag[]>([]);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailContactId, setDetailContactId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  // Delete single contact
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Smart delete dialog
  const [smartDeleteOpen, setSmartDeleteOpen] = useState(false);
  const [selectedDeleteTagId, setSelectedDeleteTagId] = useState<string | null>(null);
  const [deletingAll, setDeletingAll] = useState(false);
  const [deletingByTag, setDeletingByTag] = useState(false);

  // All tags for display & smart delete
  const [tagsMap, setTagsMap] = useState<Record<string, Tag>>({});
  const [allTags, setAllTags] = useState<Tag[]>([]);

  const fetchTags = useCallback(async () => {
    const { data } = await supabase.from('tags').select('*').order('name');
    if (data) {
      const map: Record<string, Tag> = {};
      data.forEach((t) => (map[t.id] = t));
      setTagsMap(map);
      setAllTags(data);
    }
  }, [supabase]);

  const fetchContacts = useCallback(async () => {
    setLoading(true);

    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    let query = supabase
      .from('contacts')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);

    if (search.trim()) {
      const term = `%${search.trim()}%`;
      query = query.or(`name.ilike.${term},phone.ilike.${term},email.ilike.${term}`);
    }

    const { data, count, error } = await query;

    if (error) {
      toast.error('Failed to load contacts');
      setLoading(false);
      return;
    }

    setTotalCount(count ?? 0);

    if (!data || data.length === 0) {
      setContacts([]);
      setLoading(false);
      return;
    }

    const contactIds = data.map((c) => c.id);
    const { data: contactTags } = await supabase
      .from('contact_tags')
      .select('contact_id, tag_id')
      .in('contact_id', contactIds);

    const tagsByContact: Record<string, string[]> = {};
    contactTags?.forEach((ct) => {
      if (!tagsByContact[ct.contact_id]) tagsByContact[ct.contact_id] = [];
      tagsByContact[ct.contact_id].push(ct.tag_id);
    });

    const enriched: ContactWithTags[] = data.map((c) => ({
      ...c,
      tags: (tagsByContact[c.id] ?? [])
        .map((tid) => tagsMap[tid])
        .filter(Boolean),
    }));

    setContacts(enriched);
    setLoading(false);
  }, [supabase, page, search, tagsMap]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchTags();
  }, [fetchTags]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContacts();
  }, [fetchContacts]);

  function openAddForm() {
    setEditContact(null);
    setEditContactTags([]);
    setFormOpen(true);
  }

  async function openEditForm(contact: Contact) {
    const { data } = await supabase
      .from('contact_tags')
      .select('*')
      .eq('contact_id', contact.id);
    setEditContact(contact);
    setEditContactTags(data ?? []);
    setFormOpen(true);
  }

  function openDetail(contactId: string) {
    setDetailContactId(contactId);
    setDetailOpen(true);
  }

  function confirmDelete(contact: Contact) {
    setDeleteTarget(contact);
    setDeleteConfirmOpen(true);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);

    const { error } = await supabase
      .from('contacts')
      .delete()
      .eq('id', deleteTarget.id);

    if (error) {
      toast.error('Failed to delete contact');
    } else {
      toast.success('Contact deleted');
      fetchContacts();
    }

    setDeleting(false);
    setDeleteConfirmOpen(false);
    setDeleteTarget(null);
  }

  // Delete ALL contacts for this user
  async function handleDeleteAll() {
    setDeletingAll(true);

    const { data: { session } } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      toast.error('Not authenticated');
      setDeletingAll(false);
      return;
    }

    const { error } = await supabase
      .from('contacts')
      .delete()
      .eq('user_id', user.id);

    if (error) {
      toast.error('Failed to delete all contacts');
    } else {
      toast.success('All contacts deleted');
      setPage(0);
      fetchContacts();
    }

    setDeletingAll(false);
    setSmartDeleteOpen(false);
    setSelectedDeleteTagId(null);
  }

  // Delete contacts by selected tag
  async function handleDeleteByTag() {
    if (!selectedDeleteTagId) return;
    setDeletingByTag(true);

    // 1. Get all contact_ids linked to this tag
    const { data: tagLinks, error: tagLinksError } = await supabase
      .from('contact_tags')
      .select('contact_id')
      .eq('tag_id', selectedDeleteTagId);

    if (tagLinksError || !tagLinks || tagLinks.length === 0) {
      toast.error(tagLinksError ? 'Failed to fetch contacts for tag' : 'No contacts found for this tag');
      setDeletingByTag(false);
      return;
    }

    const contactIds = tagLinks.map((r) => r.contact_id);

    // 2. Delete those contacts
    const { error } = await supabase
      .from('contacts')
      .delete()
      .in('id', contactIds);

    if (error) {
      toast.error('Failed to delete contacts for this tag');
    } else {
      const tagName = tagsMap[selectedDeleteTagId]?.name ?? 'tag';
      toast.success(`All contacts with tag "${tagName}" deleted`);
      setPage(0);
      fetchContacts();
    }

    setDeletingByTag(false);
    setSmartDeleteOpen(false);
    setSelectedDeleteTagId(null);
  }

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const hasNext = page < totalPages - 1;
  const hasPrev = page > 0;

  const isDeleting = deletingAll || deletingByTag;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Contacts</h1>
          <p className="text-sm text-slate-400 mt-1">
            Manage your contact list. {totalCount > 0 && `${totalCount} total contacts.`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Smart Delete Button */}
          <Button
            variant="outline"
            onClick={() => {
              setSelectedDeleteTagId(null);
              setSmartDeleteOpen(true);
            }}
            disabled={totalCount === 0}
            className="border-red-800 text-red-400 hover:bg-red-950 hover:text-red-300 disabled:opacity-30"
          >
            <Trash2 className="size-4" />
            Delete
          </Button>

          <Button
            variant="outline"
            onClick={() => setImportOpen(true)}
            className="border-slate-700 text-slate-300 hover:bg-slate-800"
          >
            <Upload className="size-4" />
            Import
          </Button>
          <Button
            onClick={openAddForm}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            <Plus className="size-4" />
            Add Contact
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-slate-500" />
        <Input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
          placeholder="Search by name, phone, or email..."
          className="pl-8 bg-slate-900 border-slate-700 text-white placeholder:text-slate-500"
        />
      </div>

      {/* Table */}
      <div className="rounded-lg border border-slate-800 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-slate-800 hover:bg-transparent">
              <TableHead className="text-slate-400">Name</TableHead>
              <TableHead className="text-slate-400">Phone</TableHead>
              <TableHead className="text-slate-400 hidden md:table-cell">Email</TableHead>
              <TableHead className="text-slate-400 hidden lg:table-cell">Company</TableHead>
              <TableHead className="text-slate-400 hidden md:table-cell">Tags</TableHead>
              <TableHead className="text-slate-400 hidden lg:table-cell">Created</TableHead>
              <TableHead className="text-slate-400 w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow className="border-slate-800">
                <TableCell colSpan={7} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="size-6 animate-spin text-primary" />
                    <p className="text-sm text-slate-500">Loading contacts...</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : contacts.length === 0 ? (
              <TableRow className="border-slate-800">
                <TableCell colSpan={7} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <Users className="size-8 text-slate-600" />
                    <p className="text-sm text-slate-500">
                      {search ? 'No contacts match your search.' : 'No contacts yet.'}
                    </p>
                    {!search && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={openAddForm}
                        className="mt-2 border-slate-700 text-slate-300 hover:bg-slate-800"
                      >
                        <Plus className="size-3.5" />
                        Add your first contact
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              contacts.map((contact) => (
                <TableRow
                  key={contact.id}
                  className="border-slate-800 hover:bg-slate-900/50 cursor-pointer"
                  onClick={() => openDetail(contact.id)}
                >
                  <TableCell className="text-white font-medium">
                    {contact.name || <span className="text-slate-500 italic">Unnamed</span>}
                  </TableCell>
                  <TableCell className="text-slate-300 font-mono text-xs">
                    {contact.phone}
                  </TableCell>
                  <TableCell className="text-slate-400 hidden md:table-cell text-sm">
                    {contact.email || <span className="text-slate-600">-</span>}
                  </TableCell>
                  <TableCell className="text-slate-400 hidden lg:table-cell text-sm">
                    {contact.company || <span className="text-slate-600">-</span>}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {contact.tags && contact.tags.length > 0 ? (
                        contact.tags.slice(0, 3).map((tag) => (
                          <span
                            key={tag.id}
                            className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                            style={{
                              backgroundColor: tag.color + '20',
                              color: tag.color,
                            }}
                          >
                            {tag.name}
                          </span>
                        ))
                      ) : (
                        <span className="text-slate-600 text-xs">-</span>
                      )}
                      {contact.tags && contact.tags.length > 3 && (
                        <span className="text-[10px] text-slate-500">
                          +{contact.tags.length - 3}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-slate-500 text-xs hidden lg:table-cell">
                    {new Date(contact.created_at).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-slate-400 hover:text-white"
                            onClick={(e) => e.stopPropagation()}
                          />
                        }
                      >
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        className="bg-slate-900 border-slate-700"
                      >
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            openEditForm(contact);
                          }}
                          className="text-slate-300 focus:bg-slate-800 focus:text-white"
                        >
                          <Pencil className="size-4" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuSeparator className="bg-slate-700" />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            confirmDelete(contact);
                          }}
                        >
                          <Trash2 className="size-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-slate-500">
            Showing {page * PAGE_SIZE + 1}-{Math.min((page + 1) * PAGE_SIZE, totalCount)} of{' '}
            {totalCount}
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!hasPrev}
              onClick={() => setPage((p) => p - 1)}
              className="border-slate-700 text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-30"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="text-xs text-slate-400 px-2">
              Page {page + 1} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!hasNext}
              onClick={() => setPage((p) => p + 1)}
              className="border-slate-700 text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-30"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Contact Form Dialog */}
      <ContactForm
        open={formOpen}
        onOpenChange={setFormOpen}
        contact={editContact}
        contactTags={editContactTags}
        onSaved={() => {
          fetchContacts();
          fetchTags();
        }}
      />

      {/* Contact Detail Sheet */}
      <ContactDetailView
        open={detailOpen}
        onOpenChange={setDetailOpen}
        contactId={detailContactId}
        onUpdated={fetchContacts}
      />

      {/* Import Modal */}
      <ImportModal
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={fetchContacts}
      />

      {/* Delete Single Contact Confirmation */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="bg-slate-900 border-slate-700 text-slate-200 sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-white">Delete Contact</DialogTitle>
            <DialogDescription className="text-slate-400">
              Are you sure you want to delete{' '}
              <span className="text-slate-200 font-medium">
                {deleteTarget?.name || deleteTarget?.phone}
              </span>
              ? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-slate-900 border-slate-700">
            <Button
              variant="outline"
              onClick={() => setDeleteConfirmOpen(false)}
              className="border-slate-700 text-slate-300 hover:bg-slate-800"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Smart Delete Dialog */}
      <Dialog
        open={smartDeleteOpen}
        onOpenChange={(o) => {
          if (!o) setSelectedDeleteTagId(null);
          setSmartDeleteOpen(o);
        }}
      >
        <DialogContent className="bg-slate-900 border-slate-700 text-slate-200 sm:max-w-md flex flex-col max-h-[90vh] overflow-hidden">
          <DialogHeader className="shrink-0">
            <DialogTitle className="text-white">Delete Contacts</DialogTitle>
            <DialogDescription className="text-slate-400">
              Delete all contacts at once, or select a tag to delete only contacts assigned to that tag.
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto py-3 space-y-4">

            {/* Delete All option */}
            <div
              onClick={() => !isDeleting && setSelectedDeleteTagId(null)}
              className={`rounded-lg border p-3 cursor-pointer transition-all ${
                selectedDeleteTagId === null
                  ? 'border-red-600 bg-red-950/40'
                  : 'border-slate-700 hover:border-slate-600'
              }`}
            >
              <div className="flex items-center gap-2">
                <div
                  className={`size-3.5 rounded-full border-2 shrink-0 ${
                    selectedDeleteTagId === null
                      ? 'border-red-500 bg-red-500'
                      : 'border-slate-500'
                  }`}
                />
                <div>
                  <p className="text-sm font-medium text-white">Delete All Contacts</p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Permanently removes all {totalCount} contacts
                  </p>
                </div>
              </div>
            </div>

            {/* Divider */}
            <div className="flex items-center gap-2">
              <div className="flex-1 h-px bg-slate-700" />
              <span className="text-xs text-slate-500">or delete by tag</span>
              <div className="flex-1 h-px bg-slate-700" />
            </div>

            {/* Tag list */}
            {allTags.length === 0 ? (
              <p className="text-xs text-slate-500 text-center py-4">
                No tags available.
              </p>
            ) : (
              <div className="space-y-1.5">
                {allTags.map((tag) => (
                  <div
                    key={tag.id}
                    onClick={() => !isDeleting && setSelectedDeleteTagId(tag.id)}
                    className={`rounded-lg border p-3 cursor-pointer transition-all ${
                      selectedDeleteTagId === tag.id
                        ? 'border-red-600 bg-red-950/40'
                        : 'border-slate-700 hover:border-slate-600'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <div
                        className={`size-3.5 rounded-full border-2 shrink-0 ${
                          selectedDeleteTagId === tag.id
                            ? 'border-red-500 bg-red-500'
                            : 'border-slate-500'
                        }`}
                      />
                      <span
                        className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                        style={{
                          backgroundColor: tag.color + '20',
                          color: tag.color,
                        }}
                      >
                        {tag.name}
                      </span>
                      <span className="text-xs text-slate-500 ml-auto">
                        Delete all contacts with this tag
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <DialogFooter className="shrink-0 border-t border-slate-700 pt-3 bg-slate-900">
            <Button
              variant="outline"
              onClick={() => {
                setSelectedDeleteTagId(null);
                setSmartDeleteOpen(false);
              }}
              disabled={isDeleting}
              className="border-slate-700 text-slate-300 hover:bg-slate-800"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={isDeleting}
              onClick={selectedDeleteTagId === null ? handleDeleteAll : handleDeleteByTag}
            >
              {isDeleting && <Loader2 className="size-4 animate-spin" />}
              {selectedDeleteTagId === null
                ? `Delete All ${totalCount} Contacts`
                : `Delete Contacts with "${tagsMap[selectedDeleteTagId]?.name}"`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
